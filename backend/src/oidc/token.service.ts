import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { hashToken, randomToken } from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { canonicalRedirectUri } from '../applications/redirect-uri';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { identityGate } from '../identities/identity-state';
import { SessionsService, type LiveSession } from '../sessions/sessions.service';
import type { AuthenticatedClient } from './client-authentication.service';
import { IssuerService } from './issuer.service';
import { splitScope, scopeWithin } from './scopes';
import { SigningKeysService } from './signing-keys.service';
import { optionalText } from '../common/text';

export type TokenErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'unsupported_grant_type';

export interface TokenSuccess {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  id_token: string;
  refresh_token: string;
  scope: string;
}

export type TokenResult =
  | { status: 200; body: TokenSuccess }
  | { status: 400 | 401; error: TokenErrorCode; error_description: string };

export interface TokenRequest {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
  scope?: string;
  client_id?: unknown;
  client_secret?: unknown;
  [key: string]: unknown;
}

export interface IntrospectionResult {
  active: boolean;
  scope?: string;
  client_id?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string;
  jti?: string;
  token_type?: string;
}

export type UserInfoResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 401; description: string };

interface CodeRow {
  id: string;
  application_id: string;
  identity_id: string;
  session_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string | null;
  nonce: string | null;
  expires_at: string;
}

interface RefreshRow {
  id: string;
  session_id: string;
  organization_id: string;
  application_id: string;
  identity_id: string;
  scope: string;
  created_at: string;
  expires_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

interface IdentityRow {
  id: string;
  email: string;
  email_verified: number;
  suspended_at: string | null;
  anonymized_at: string | null;
}

/**
 * The token machinery completing the OIDC core (ADR-0013, ADR-0015): the
 * authorization-code exchange with client authentication and PKCE, refresh
 * token rotation as children of the Session, and the platform-side
 * validation of access tokens for userinfo and introspection.
 *
 * Deliberate shapes: the authorization code is consumed atomically before the
 * remaining checks, so a bad PKCE verifier or redirect URI burns it and the
 * endpoint is never a guessing oracle; refresh rotation revokes the whole
 * lineage when a spent token is presented again (the theft signal); access
 * tokens are untracked signed JWTs that die within their short TTL, while
 * refresh tokens live in verifiable form only and die with their Session.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionsService,
    private readonly enrollments: EnrollmentsService,
    private readonly signing: SigningKeysService,
    private readonly issuer: IssuerService,
  ) {}

  /**
   * The Identity a token request targets, for throttling the token surface
   * per-Identity (ADR-0020). Resolved best-effort from the presented grant: a
   * code or refresh token names its Identity even when it is expired, spent,
   * or revoked, so repeated attempts against it are slowed. An unresolvable
   * grant yields null and only the source dimension applies.
   */
  async identityForGrant(request: TokenRequest): Promise<string | null> {
    const code = optionalText(request.code);
    if (code) {
      const row = await this.db.get<{ identity_id: string }>(
        'SELECT identity_id FROM authorization_codes WHERE code_hash = ?',
        [hashToken(code)],
      );
      return row?.identity_id ?? null;
    }
    const refreshToken = optionalText(request.refresh_token);
    if (refreshToken) {
      const row = await this.db.get<{ identity_id: string }>(
        'SELECT identity_id FROM refresh_tokens WHERE token_hash = ?',
        [hashToken(refreshToken)],
      );
      return row?.identity_id ?? null;
    }
    return null;
  }

  async handleGrant(
    client: AuthenticatedClient,
    request: TokenRequest,
  ): Promise<TokenResult> {
    // A Disabled or Deleted Application mints no new tokens (ADR-0007). Client
    // authentication already succeeded — a pause is not credential revocation —
    // so the refusal is a grant-level one, and refresh tokens the Application
    // minted earlier have been revoked.
    if (!client.enabled) {
      return invalidGrant('the Application is not available');
    }
    const grantType = optionalText(request.grant_type);
    if (!grantType) return invalidRequest('grant_type is required');
    if (grantType === 'authorization_code') return this.exchangeCode(client, request);
    if (grantType === 'refresh_token') return this.rotateRefresh(client, request);
    return {
      status: 400,
      error: 'unsupported_grant_type',
      error_description: `grant_type "${grantType}" is not supported`,
    };
  }

  private async exchangeCode(
    client: AuthenticatedClient,
    request: TokenRequest,
  ): Promise<TokenResult> {
    const code = optionalText(request.code);
    if (!code) return invalidRequest('code is required');

    const row = await this.db.get<CodeRow>(
      `SELECT id, application_id, identity_id, session_id, redirect_uri, scope,
              code_challenge, nonce, expires_at
       FROM authorization_codes WHERE code_hash = ?`,
      [hashToken(code)],
    );
    if (!row) return invalidGrant('the authorization code is invalid');

    // Single-use, race-free, and deliberately first: a spent code stays spent
    // even when the rest of the exchange fails.
    const now = new Date().toISOString();
    const consumed = await this.db.run(
      'UPDATE authorization_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
      [now, row.id],
    );
    if (consumed.rowCount !== 1) {
      return invalidGrant('the authorization code has already been used');
    }
    if (row.expires_at <= now) return invalidGrant('the authorization code has expired');
    if (row.application_id !== client.id) {
      return invalidGrant('the authorization code was not issued to this client');
    }

    const redirectUri = optionalText(request.redirect_uri);
    if (!redirectUri) return invalidRequest('redirect_uri is required');
    if (canonicalRedirectUri(redirectUri) !== row.redirect_uri) {
      return invalidGrant('redirect_uri does not match the authorization request');
    }

    const pkce = this.pkceProblem(client, row, optionalText(request.code_verifier));
    if (pkce) return pkce;

    const session = await this.sessions.resolveById(row.session_id, { touch: true });
    if (!session) return invalidGrant('the Session that authorized this code is no longer valid');
    const identity = await this.findIdentity(row.identity_id);
    if (!identity || !this.isLive(identity)) {
      return invalidGrant('the Identity is no longer permitted to authenticate');
    }
    if (!(await this.enrollments.allows(row.identity_id, row.application_id))) {
      return invalidGrant('the Identity is not permitted to use this Application');
    }

    // The Application's configured scopes are the current contract: a code
    // issued before a narrowing cannot be exchanged into claims the
    // Application is no longer configured for.
    const scopes = splitScope(row.scope);
    if (!scopeWithin(client.allowedScopes, scopes)) {
      return invalidGrant('the Application is no longer configured for these scopes');
    }

    const body = await this.mint({
      client,
      identity,
      session,
      scopes,
      ...(row.nonce !== null ? { nonce: row.nonce } : {}),
    });
    if (!body) return invalidGrant('the Session that authorized this code is no longer valid');
    return { status: 200, body };
  }

  /**
   * A public client has nothing but PKCE, so the verifier is required; a
   * confidential client may rely on its secret, but when its authorization
   * request carried a challenge the verifier must match it.
   */
  private pkceProblem(
    client: AuthenticatedClient,
    row: CodeRow,
    verifier: string | undefined,
  ): TokenResult | null {
    if (row.code_challenge !== null) {
      if (!verifier) return invalidRequest('code_verifier is required');
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (computed !== row.code_challenge) {
        return invalidGrant('the PKCE code_verifier does not match the code_challenge');
      }
      return null;
    }
    if (client.type === 'spa') {
      return invalidGrant('a public client must exchange its code with PKCE');
    }
    if (verifier) {
      return invalidRequest('code_verifier was provided but no code_challenge was issued');
    }
    return null;
  }

  private async rotateRefresh(
    client: AuthenticatedClient,
    request: TokenRequest,
  ): Promise<TokenResult> {
    const raw = optionalText(request.refresh_token);
    if (!raw) return invalidRequest('refresh_token is required');

    const row = await this.findRefreshToken(raw);
    if (!row) return invalidGrant('the refresh token is invalid');
    if (row.application_id !== client.id) {
      return invalidGrant('the refresh token was not issued to this client');
    }
    if (row.revoked_at !== null) return invalidGrant('the refresh token is no longer valid');
    if (row.rotated_at !== null) {
      await this.revokeLineage(row);
      return invalidGrant('the refresh token has already been used');
    }

    const now = new Date().toISOString();
    if (row.expires_at <= now) return invalidGrant('the refresh token has expired');

    const session = await this.sessions.resolveById(row.session_id, { touch: true });
    if (!session) {
      return invalidGrant('the Session that issued this refresh token is no longer valid');
    }
    const identity = await this.findIdentity(row.identity_id);
    if (!identity || !this.isLive(identity)) {
      return invalidGrant('the Identity is no longer permitted to authenticate');
    }
    if (!(await this.enrollments.allows(row.identity_id, row.application_id))) {
      return invalidGrant('the Identity is not permitted to use this Application');
    }

    // A refresh may narrow its scopes, never widen them (RFC 6749 §6), and the
    // effective set must remain within what the Application is configured for
    // now: narrowing `allowed_scopes` must actually bite, even for a client
    // that keeps refreshing.
    const granted = splitScope(row.scope);
    const requested = optionalText(request.scope);
    const scopes = requested === undefined ? granted : narrowScope(granted, requested);
    if (!scopes) {
      return {
        status: 400,
        error: 'invalid_scope',
        error_description: 'the requested scope exceeds the original grant',
      };
    }
    if (!scopeWithin(client.allowedScopes, scopes)) {
      return {
        status: 400,
        error: 'invalid_scope',
        error_description: 'the requested scope exceeds the Application\'s configured scopes',
      };
    }

    const rotated = await this.db.run(
      `UPDATE refresh_tokens SET rotated_at = ?
         WHERE id = ? AND rotated_at IS NULL AND revoked_at IS NULL`,
      [now, row.id],
    );
    if (rotated.rowCount !== 1) {
      await this.revokeLineage(row);
      return invalidGrant('the refresh token has already been used');
    }

    const body = await this.mint({ client, identity, session, scopes });
    if (!body) return invalidGrant('the Session that issued this refresh token is no longer valid');
    return { status: 200, body };
  }

  /**
   * Presenting a spent refresh token is the standard theft signal (OAuth 2.0
   * Security BCP): the whole lineage — every refresh token of the Session that
   * minted it, across Applications — is revoked so the attacker's copy and the
   * victim's copy are both dead, and the event is audited.
   */
  private async revokeLineage(row: RefreshRow): Promise<void> {
    const revoked = await this.db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), row.session_id],
    );
    if (revoked.rowCount === 0) return;
    await recordAuditEvent(this.db, {
      organizationId: row.organization_id,
      actor: 'end-user',
      kind: 'refresh_token.reuse.detected',
      detail: {
        identityId: row.identity_id,
        applicationId: row.application_id,
        sessionId: row.session_id,
      },
    });
  }

  private async mint(input: {
    client: AuthenticatedClient;
    identity: IdentityRow;
    session: LiveSession;
    scopes: string[];
    nonce?: string;
  }): Promise<TokenSuccess | null> {
    const nowMs = Date.now();
    const iat = Math.floor(nowMs / 1000);
    const accessExpiresMs = nowMs + this.accessTtlMs();
    const exp = Math.floor(accessExpiresMs / 1000);
    const scope = input.scopes.join(' ');

    const accessToken = await this.signing.sign(
      {
        iss: this.issuer.issuer(),
        sub: input.identity.id,
        aud: this.issuer.audience(),
        client_id: input.client.clientId,
        sid: input.session.id,
        scope,
        jti: uuid(),
        iat,
        exp,
      },
      'at+jwt',
    );

    const idClaims: Record<string, unknown> = {
      iss: this.issuer.issuer(),
      sub: input.identity.id,
      aud: input.client.clientId,
      iat,
      exp,
      auth_time: Math.floor(new Date(input.session.createdAt).getTime() / 1000),
      sid: input.session.id,
    };
    if (input.nonce !== undefined) idClaims.nonce = input.nonce;
    if (input.scopes.includes('email')) {
      idClaims.email = input.identity.email;
      idClaims.email_verified = input.identity.email_verified === 1;
    }
    if (input.scopes.includes('profile')) {
      idClaims.preferred_username = input.identity.email;
    }
    const idToken = await this.signing.sign(idClaims, 'JWT');

    const refreshToken = randomToken(32);
    const refreshExpiresMs = Math.min(
      nowMs + this.refreshTtlMs(),
      new Date(input.session.expiresAt).getTime(),
    );
    // The parent, the Enrollment, and the Application are re-checked before
    // the insert, so a revocation that landed while the tokens were being
    // signed is caught (ADR-0013). The original synchronous engine made the
    // check and the insert one uninterrupted section; behind the async
    // contract they are separated by awaits, so on a concurrent engine a
    // change landing in that gap could still leave a freshly minted token
    // behind. Closing the gap needs an atomic write (conditional insert or row
    // lock), which belongs to the final data-access conversion.
    if (!(await this.sessions.resolveById(input.session.id))) return null;
    if (!(await this.enrollments.allows(input.identity.id, input.client.id))) return null;
    const application = await this.db.get<{
      disabled_at: string | null;
      deleted_at: string | null;
    }>('SELECT disabled_at, deleted_at FROM applications WHERE id = ?', [input.client.id]);
    if (!application || application.disabled_at !== null || application.deleted_at !== null) {
      return null;
    }
    await this.db.run(
      `INSERT INTO refresh_tokens
         (id, token_hash, session_id, application_id, identity_id, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        hashToken(refreshToken),
        input.session.id,
        input.client.id,
        input.identity.id,
        scope,
        new Date(nowMs).toISOString(),
        new Date(refreshExpiresMs).toISOString(),
      ],
    );

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round((accessExpiresMs - nowMs) / 1000)),
      id_token: idToken,
      refresh_token: refreshToken,
      scope,
    };
  }

  /**
   * Userinfo (OIDC Core §5.3): the claims for a valid access token. Identity
   * liveness is checked at ask-time, so a suspension takes effect here
   * immediately; the access token itself stays untracked and dies with its
   * short TTL, which is the honest limit of the design (ADR-0013).
   */
  async userInfo(accessToken: string | undefined): Promise<UserInfoResult> {
    if (!accessToken) return { status: 401, description: 'a Bearer access token is required' };
    const claims = await this.signing.verifyAccessToken(accessToken);
    if (!claims) return { status: 401, description: 'the access token is invalid or expired' };

    const identity = await this.findIdentity(claims.sub);
    if (!identity || !this.isLive(identity)) {
      return { status: 401, description: 'the access token is no longer valid' };
    }

    const scopes = splitScope(claims.scope);
    const body: Record<string, unknown> = { sub: identity.id };
    if (scopes.includes('email')) {
      body.email = identity.email;
      body.email_verified = identity.email_verified === 1;
    }
    if (scopes.includes('profile')) {
      body.preferred_username = identity.email;
    }
    return { status: 200, body };
  }

  /**
   * Introspection (RFC 7662): the platform answers for its own tokens. Access
   * tokens answer from their verified claims plus live Identity state; refresh
   * tokens answer only while their parent Session is live and they have not
   * been rotated or revoked. A client only ever sees verdicts about its own
   * tokens.
   */
  async introspect(
    client: AuthenticatedClient,
    token: string | undefined,
  ): Promise<IntrospectionResult> {
    if (!token) return { active: false };

    const claims = await this.signing.verifyAccessToken(token);
    if (claims && claims.client_id === client.clientId) {
      const identity = await this.findIdentity(claims.sub);
      if (identity && this.isLive(identity)) {
        return {
          active: true,
          scope: claims.scope,
          client_id: claims.client_id,
          sub: claims.sub,
          exp: claims.exp,
          iat: claims.iat,
          iss: typeof claims.iss === 'string' ? claims.iss : undefined,
          aud: typeof claims.aud === 'string' ? claims.aud : undefined,
          jti: claims.jti,
          token_type: 'Bearer',
        };
      }
    }

    const row = await this.findRefreshToken(token);
    if (row && row.application_id === client.id) {
      const now = new Date().toISOString();
      if (row.revoked_at === null && row.rotated_at === null && row.expires_at > now) {
        const session = await this.sessions.resolveById(row.session_id);
        if (session && (await this.enrollments.allows(row.identity_id, row.application_id))) {
          return {
            active: true,
            scope: row.scope,
            client_id: client.clientId,
            sub: row.identity_id,
            exp: epochSeconds(row.expires_at),
            iat: epochSeconds(row.created_at),
            iss: this.issuer.issuer(),
            aud: this.issuer.audience(),
            token_type: 'refresh_token',
          };
        }
      }
    }

    return { active: false };
  }

  /**
   * Revocation (RFC 7009): revokes refresh tokens. Access tokens are untracked
   * by design and cannot be revoked — the response is deliberately uniform,
   * because an invalid or unknown token must not reveal anything.
   */
  async revoke(client: AuthenticatedClient, token: string | undefined): Promise<void> {
    if (!token) return;
    const row = await this.findRefreshToken(token);
    if (!row || row.application_id !== client.id || row.revoked_at !== null) return;
    await this.db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
      new Date().toISOString(),
      row.id,
    ]);
  }

  private async findIdentity(identityId: string): Promise<IdentityRow | undefined> {
    return this.db.get<IdentityRow>(
      'SELECT id, email, email_verified, suspended_at, anonymized_at FROM identities WHERE id = ?',
      [identityId],
    );
  }

  private async findRefreshToken(token: string): Promise<RefreshRow | undefined> {
    return this.db.get<RefreshRow>(
      `SELECT rt.id, rt.session_id, rt.application_id, rt.identity_id, rt.scope,
              rt.created_at, rt.expires_at, rt.rotated_at, rt.revoked_at,
              s.organization_id
       FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
       WHERE rt.token_hash = ?`,
      [hashToken(token)],
    );
  }

  /** An Identity is usable only while verified, not suspended, not anonymized
   * (ADR-0006/0011/0007). The row is still raw; ticket 13 converts it. */
  private isLive(identity: IdentityRow): boolean {
    return (
      identityGate({
        emailVerified: identity.email_verified,
        suspendedAt: identity.suspended_at,
        anonymizedAt: identity.anonymized_at,
      }) === 'live'
    );
  }

  private accessTtlMs(): number {
    return parseTtlMs('IDENTIK_ACCESS_TOKEN_TTL_MS', 5 * 60 * 1000);
  }

  private refreshTtlMs(): number {
    return parseTtlMs('IDENTIK_REFRESH_TOKEN_TTL_MS', 30 * 24 * 60 * 60 * 1000);
  }
}

function invalidRequest(description: string): TokenResult {
  return { status: 400, error: 'invalid_request', error_description: description };
}

function invalidGrant(description: string): TokenResult {
  return { status: 400, error: 'invalid_grant', error_description: description };
}

/** The requested scopes, or null when any of them was never granted. */
function narrowScope(granted: string[], requested: string): string[] | null {
  const allowed = new Set(granted);
  const scopes = splitScope(requested);
  if (scopes.length === 0) return null;
  return scopes.every((scope) => allowed.has(scope)) ? scopes : null;
}

function epochSeconds(instant: string): number {
  return Math.floor(new Date(instant).getTime() / 1000);
}
