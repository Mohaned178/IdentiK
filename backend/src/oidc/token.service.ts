import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { hashToken, randomToken } from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { canonicalRedirectUri } from '../applications/redirect-uri';
import type { Prisma } from '../generated/prisma/client';
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

/**
 * The authorization-code fields the exchange needs. The stored hash is
 * deliberately absent: the exchange looks the code up by hash and never
 * carries the credential forward.
 */
const CODE_SELECT = {
  id: true,
  applicationId: true,
  identityId: true,
  sessionId: true,
  redirectUri: true,
  scope: true,
  codeChallenge: true,
  nonce: true,
  expiresAt: true,
} as const;

type CodeExchange = Prisma.AuthorizationCodeGetPayload<{ select: typeof CODE_SELECT }>;

/** A refresh token plus the Organization its parent Session belongs to. */
const REFRESH_WITH_SESSION = {
  session: { select: { organizationId: true } },
} as const satisfies Prisma.RefreshTokenInclude;

type RefreshTokenWithSession = Prisma.RefreshTokenGetPayload<{
  include: typeof REFRESH_WITH_SESSION;
}>;

/**
 * The Identity as the token surface sees it: the liveness gate fields plus
 * the claims it may emit — never a credential (ADR-0008).
 */
const TOKEN_IDENTITY_SELECT = {
  id: true,
  email: true,
  emailVerified: true,
  suspendedAt: true,
  anonymizedAt: true,
} as const;

type TokenIdentity = Prisma.IdentityGetPayload<{ select: typeof TOKEN_IDENTITY_SELECT }>;

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
      const row = await this.db.authorizationCode.findUnique({
        where: { codeHash: hashToken(code) },
        select: { identityId: true },
      });
      return row?.identityId ?? null;
    }
    const refreshToken = optionalText(request.refresh_token);
    if (refreshToken) {
      const row = await this.db.refreshToken.findUnique({
        where: { tokenHash: hashToken(refreshToken) },
        select: { identityId: true },
      });
      return row?.identityId ?? null;
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

    const row = await this.db.authorizationCode.findUnique({
      where: { codeHash: hashToken(code) },
      select: CODE_SELECT,
    });
    if (!row) return invalidGrant('the authorization code is invalid');

    // Single-use, race-free, and deliberately first: a spent code stays spent
    // even when the rest of the exchange fails.
    const now = new Date().toISOString();
    const consumed = await this.db.authorizationCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      return invalidGrant('the authorization code has already been used');
    }
    if (row.expiresAt <= now) return invalidGrant('the authorization code has expired');
    if (row.applicationId !== client.id) {
      return invalidGrant('the authorization code was not issued to this client');
    }

    const redirectUri = optionalText(request.redirect_uri);
    if (!redirectUri) return invalidRequest('redirect_uri is required');
    if (canonicalRedirectUri(redirectUri) !== row.redirectUri) {
      return invalidGrant('redirect_uri does not match the authorization request');
    }

    const pkce = this.pkceProblem(client, row, optionalText(request.code_verifier));
    if (pkce) return pkce;

    const session = await this.sessions.resolveById(row.sessionId, { touch: true });
    if (!session) return invalidGrant('the Session that authorized this code is no longer valid');
    const identity = await this.findIdentity(row.identityId);
    if (!identity || !this.isLive(identity)) {
      return invalidGrant('the Identity is no longer permitted to authenticate');
    }
    if (!(await this.enrollments.allows(row.identityId, row.applicationId))) {
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
    row: CodeExchange,
    verifier: string | undefined,
  ): TokenResult | null {
    if (row.codeChallenge !== null) {
      if (!verifier) return invalidRequest('code_verifier is required');
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (computed !== row.codeChallenge) {
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
    if (row.applicationId !== client.id) {
      return invalidGrant('the refresh token was not issued to this client');
    }
    if (row.revokedAt !== null) return invalidGrant('the refresh token is no longer valid');
    if (row.rotatedAt !== null) {
      await this.revokeLineage(row);
      return invalidGrant('the refresh token has already been used');
    }

    const now = new Date().toISOString();
    if (row.expiresAt <= now) return invalidGrant('the refresh token has expired');

    const session = await this.sessions.resolveById(row.sessionId, { touch: true });
    if (!session) {
      return invalidGrant('the Session that issued this refresh token is no longer valid');
    }
    const identity = await this.findIdentity(row.identityId);
    if (!identity || !this.isLive(identity)) {
      return invalidGrant('the Identity is no longer permitted to authenticate');
    }
    if (!(await this.enrollments.allows(row.identityId, row.applicationId))) {
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

    const rotated = await this.db.refreshToken.updateMany({
      where: { id: row.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: now },
    });
    if (rotated.count !== 1) {
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
  private async revokeLineage(row: RefreshTokenWithSession): Promise<void> {
    const revoked = await this.db.refreshToken.updateMany({
      where: { sessionId: row.sessionId, revokedAt: null },
      data: { revokedAt: new Date().toISOString() },
    });
    if (revoked.count === 0) return;
    await recordAuditEvent(this.db, {
      organizationId: row.session.organizationId,
      actor: 'end-user',
      kind: 'refresh_token.reuse.detected',
      detail: {
        identityId: row.identityId,
        applicationId: row.applicationId,
        sessionId: row.sessionId,
      },
    });
  }

  private async mint(input: {
    client: AuthenticatedClient;
    identity: TokenIdentity;
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
      idClaims.email_verified = input.identity.emailVerified === 1;
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
    // contract they are separated by awaits, so a change landing in that gap
    // can still leave a freshly minted token behind. Closing the gap needs an
    // atomic write (conditional insert or row lock); this migration is
    // behavior-preserving, so the window stays as it was and closing it is a
    // separate change.
    if (!(await this.sessions.resolveById(input.session.id))) return null;
    if (!(await this.enrollments.allows(input.identity.id, input.client.id))) return null;
    const application = await this.db.application.findUnique({
      where: { id: input.client.id },
      select: { disabledAt: true, deletedAt: true },
    });
    if (!application || application.disabledAt !== null || application.deletedAt !== null) {
      return null;
    }
    await this.db.refreshToken.create({
      data: {
        id: uuid(),
        tokenHash: hashToken(refreshToken),
        sessionId: input.session.id,
        applicationId: input.client.id,
        identityId: input.identity.id,
        scope,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(refreshExpiresMs).toISOString(),
      },
    });

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
      body.email_verified = identity.emailVerified === 1;
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
    if (row && row.applicationId === client.id) {
      const now = new Date().toISOString();
      if (row.revokedAt === null && row.rotatedAt === null && row.expiresAt > now) {
        const session = await this.sessions.resolveById(row.sessionId);
        if (session && (await this.enrollments.allows(row.identityId, row.applicationId))) {
          return {
            active: true,
            scope: row.scope,
            client_id: client.clientId,
            sub: row.identityId,
            exp: epochSeconds(row.expiresAt),
            iat: epochSeconds(row.createdAt),
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
    if (!row || row.applicationId !== client.id || row.revokedAt !== null) return;
    await this.db.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date().toISOString() },
    });
  }

  private async findIdentity(identityId: string): Promise<TokenIdentity | null> {
    return this.db.identity.findUnique({
      where: { id: identityId },
      select: TOKEN_IDENTITY_SELECT,
    });
  }

  private async findRefreshToken(token: string): Promise<RefreshTokenWithSession | null> {
    return this.db.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: REFRESH_WITH_SESSION,
    });
  }

  /** An Identity is usable only while verified, not suspended, not anonymized
   * (ADR-0006/0011/0007). */
  private isLive(identity: TokenIdentity): boolean {
    return identityGate(identity) === 'live';
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
