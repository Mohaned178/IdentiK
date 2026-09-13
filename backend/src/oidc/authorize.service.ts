import { Inject, Injectable } from '@nestjs/common';
import { hashToken, randomToken } from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';
import {
  ApplicationsService,
  AuthorizeClient,
  ApplicationType,
} from '../applications/applications.service';
import { canonicalRedirectUri } from '../applications/redirect-uri';
import { normalizeEmail } from '../identities/email';
import { IdentitiesService, IdentityAuthentication } from '../identities/identities.service';
import { SessionsService, SsoSession } from '../sessions/sessions.service';
import {
  OrganizationSettingsService,
  type Branding,
} from '../settings/organization-settings.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { parseSupportedScope, scopeWithin } from './scopes';
import { optionalText } from '../common/text';

const S256_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export interface AuthorizationRequest {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface SignInPage {
  organizationName: string;
  applicationName: string;
  branding: Branding;
  request: {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string | null;
    nonce: string | null;
    codeChallenge: string | null;
    codeChallengeMethod: string | null;
  };
}

export type AuthorizeOutcome =
  | { kind: 'page'; page: SignInPage }
  | { kind: 'redirect'; location: string }
  | { kind: 'error-page'; status: number; error: string; errorDescription: string };

export type AuthorizationSignInOutcome =
  | AuthorizeOutcome
  | { kind: 'redirect-with-session'; location: string; sessionToken: string }
  | { kind: 'invalid-credentials' };

export interface SignInContext {
  source: string | null;
  userAgent: string | null;
}

interface ValidatedRequest {
  application: AuthorizeClient;
  redirectUri: string;
  scope: string[];
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/** The Session a code is bound to, as the enrollment and code writers need it. */
interface ActingDevice {
  sessionId: string;
  identityId: string;
  email: string;
}

type Validation =
  | { kind: 'ok'; request: ValidatedRequest }
  | { kind: 'invalid'; outcome: AuthorizeOutcome };

/**
 * The authorization endpoint's brain (ADR-0015, ADR-0018). The order is the
 * security property: the Client ID and the redirect URI are validated before
 * anything else, and an unvalidated URI is never a redirect target — protocol
 * errors can only travel back to a URI the Application registered. A live
 * Session is reused without a password (the SSO moment), the first
 * authentication through an Application silently creates its Enrollment, and
 * the issued code is single-use and short-lived by construction; ticket 10's
 * token exchange is where consumption and replay refusal are exercised.
 */
@Injectable()
export class AuthorizeService {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly identities: IdentitiesService,
    private readonly sessions: SessionsService,
    private readonly enrollments: EnrollmentsService,
    private readonly settings: OrganizationSettingsService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** GET: reuse a live Session, or render the hosted sign-in page. */
  async begin(request: AuthorizationRequest, ssoToken: string | null): Promise<AuthorizeOutcome> {
    const validated = await this.validate(request);
    if (validated.kind === 'invalid') return validated.outcome;

    const session = await this.reusableSession(validated.request, ssoToken);
    if (!session) return { kind: 'page', page: await this.page(validated.request) };
    return this.complete(validated.request, deviceOf(session));
  }

  /**
   * POST: the hosted sign-in page's form target, carrying the same
   * authorization request in its query. A live Session still wins; otherwise
   * the credential is verified and a new Session begins.
   */
  async signIn(
    request: AuthorizationRequest,
    credentials: { email: string; password: string },
    ssoToken: string | null,
    context: SignInContext,
  ): Promise<AuthorizationSignInOutcome> {
    const validated = await this.validate(request);
    if (validated.kind === 'invalid') return validated.outcome;

    const existing = await this.reusableSession(validated.request, ssoToken);
    if (existing) {
      return this.complete(validated.request, deviceOf(existing));
    }

    const email = normalizeEmail(credentials.email);
    const authentication = await this.identities.authenticate(
      validated.request.application.organizationId,
      email,
      credentials.password,
    );
    if (!authentication.ok) {
      await this.auditFailure(validated.request.application, email, authentication, context);
      return { kind: 'invalid-credentials' };
    }

    const denied = await this.enrollmentDenial(
      validated.request,
      authentication.identity.id,
      authentication.identity.email,
    );
    if (denied) return denied;

    const session = await this.sessions.create({
      identityId: authentication.identity.id,
      organizationId: authentication.identity.organizationId,
      userAgent: context.userAgent,
    });
    return {
      kind: 'redirect-with-session',
      location: this.successRedirect(
        validated.request,
        await this.issueCode(validated.request, authentication.identity.id, session.sessionId),
      ),
      sessionToken: session.token,
    };
  }

  /**
   * A Session is only reusable for an Application in its own Organization
   * (ADR-0001). Single Organization per Instance today, but the scope is
   * enforced from day one.
   */
  private async reusableSession(
    request: ValidatedRequest,
    ssoToken: string | null,
  ): Promise<SsoSession | null> {
    if (!ssoToken) return null;
    const session = await this.sessions.resolve(ssoToken);
    if (!session) return null;
    if (session.organizationId !== request.application.organizationId) return null;
    return session;
  }

  /** Enrollment gate plus code issuance for an already-authenticated Identity. */
  private async complete(request: ValidatedRequest, device: ActingDevice): Promise<AuthorizeOutcome> {
    const denied = await this.enrollmentDenial(request, device.identityId, device.email);
    if (denied) return denied;
    return {
      kind: 'redirect',
      location: this.successRedirect(
        request,
        await this.issueCode(request, device.identityId, device.sessionId),
      ),
    };
  }

  /**
   * The silent Enrollment happens here (ADR-0014): first authentication
   * through an Application creates it without a consent screen. A suspended
   * Enrollment refuses this Application only, and the refusal is audited so
   * attempts against a suspended Enrollment stay visible.
   */
  private async enrollmentDenial(
    request: ValidatedRequest,
    identityId: string,
    email: string,
  ): Promise<AuthorizeOutcome | null> {
    const enrollment = await this.enrollments.authorize({
      organizationId: request.application.organizationId,
      identityId,
      applicationId: request.application.id,
      email,
    });
    if (enrollment.allowed) return null;

    await recordAuditEvent(this.db, {
      organizationId: request.application.organizationId,
      actor: 'end-user',
      kind: 'identity.authorization.refused',
      detail: {
        identityId,
        applicationId: request.application.id,
        email,
        reason: enrollment.reason,
      },
    });
    return this.errorRedirect(
      request,
      'access_denied',
      'this Identity is not permitted to use this Application',
    );
  }

  private async validate(request: AuthorizationRequest): Promise<Validation> {
    const clientId = optionalText(request.clientId);
    if (!clientId) return this.errorPage('invalid_client', 'client_id is required');
    const application = await this.applications.findForAuthorization(clientId);
    if (!application) return this.errorPage('invalid_client', 'unknown client_id');

    const rawRedirectUri = optionalText(request.redirectUri);
    const redirectUri = rawRedirectUri ? canonicalRedirectUri(rawRedirectUri) : null;
    if (!redirectUri || !application.redirectUris.includes(redirectUri)) {
      return this.errorPage(
        'invalid_redirect_uri',
        'redirect_uri is not registered for this Application',
      );
    }

    const state = this.verbatim(request.state);
    const nonce = this.verbatim(request.nonce);
    const codeChallenge = optionalText(request.codeChallenge);
    const codeChallengeMethod = optionalText(request.codeChallengeMethod);
    const base: ValidatedRequest = { application, redirectUri, scope: [], state };

    // A Disabled or Deleted Application refuses new authentication (ADR-0007).
    // The redirect URI is already validated, so the refusal can travel back to
    // the Application as a protocol error rather than an error page.
    if (!application.enabled) {
      return {
        kind: 'invalid',
        outcome: this.errorRedirect(base, 'access_denied', 'this Application is not available'),
      };
    }

    const responseType = optionalText(request.responseType);
    if (!responseType) {
      return {
        kind: 'invalid',
        outcome: this.errorRedirect(base, 'invalid_request', 'response_type is required'),
      };
    }
    if (responseType !== 'code') {
      return {
        kind: 'invalid',
        outcome: this.errorRedirect(
          base,
          'unsupported_response_type',
          'only response_type=code is supported',
        ),
      };
    }

    const scope = parseSupportedScope(request.scope);
    if (!scope) {
      return {
        kind: 'invalid',
        outcome: this.errorRedirect(
          base,
          'invalid_scope',
          'scope must include openid and only the supported scopes',
        ),
      };
    }
    // Scopes are this Application's integration configuration (ADR-0016):
    // anything it was not configured for is refused, not silently dropped.
    if (!scopeWithin(application.allowedScopes, scope)) {
      return {
        kind: 'invalid',
        outcome: this.errorRedirect(
          base,
          'invalid_scope',
          'scope exceeds the scopes configured for this Application',
        ),
      };
    }

    const pkceProblem = this.pkceProblem(application.type, codeChallenge, codeChallengeMethod);
    if (pkceProblem) {
      return {
        kind: 'invalid',
        outcome: this.errorRedirect(base, 'invalid_request', pkceProblem),
      };
    }

    return {
      kind: 'ok',
      request: { ...base, scope, nonce, codeChallenge, codeChallengeMethod },
    };
  }

  /**
   * A public client has nothing but PKCE, so the challenge is required. A
   * confidential client may rely on its secret (PKCE "replaces the secret",
   * ADR-0009), but any challenge it does present must be S256 and complete.
   */
  private pkceProblem(
    type: ApplicationType,
    challenge: string | undefined,
    method: string | undefined,
  ): string | null {
    if (!challenge) {
      if (method !== undefined) return 'code_challenge_method requires a code_challenge';
      return type === 'spa' ? 'public clients must present a PKCE code_challenge' : null;
    }
    if (method !== 'S256') return 'only code_challenge_method=S256 is supported';
    if (!S256_CHALLENGE.test(challenge)) return 'code_challenge is not a valid S256 challenge';
    return null;
  }

  private async issueCode(
    request: ValidatedRequest,
    identityId: string,
    sessionId: string,
  ): Promise<string> {
    const code = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + parseTtlMs('IDENTIK_AUTHORIZATION_CODE_TTL_MS', 60 * 1000),
    );
    await this.db.run(
      `INSERT INTO authorization_codes
         (id, code_hash, application_id, identity_id, session_id, redirect_uri, scope,
          code_challenge, code_challenge_method, nonce, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        hashToken(code),
        request.application.id,
        identityId,
        sessionId,
        request.redirectUri,
        request.scope.join(' '),
        request.codeChallenge ?? null,
        request.codeChallengeMethod ?? null,
        request.nonce ?? null,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    return code;
  }

  private async auditFailure(
    application: AuthorizeClient,
    email: string,
    authentication: Extract<IdentityAuthentication, { ok: false }>,
    context: SignInContext,
  ): Promise<void> {
    await recordAuditEvent(this.db, {
      organizationId: application.organizationId,
      actor: 'end-user',
      kind: 'identity.sign_in.failed',
      detail: {
        email,
        ...(authentication.identityId ? { identityId: authentication.identityId } : {}),
        reason: authentication.reason,
        applicationId: application.id,
        ...(context.source ? { source: context.source } : {}),
      },
    });
  }

  private async page(request: ValidatedRequest): Promise<SignInPage> {
    return {
      organizationName: request.application.organizationName,
      applicationName: request.application.name,
      branding: await this.settings.branding(request.application.organizationId),
      request: {
        clientId: request.application.clientId,
        redirectUri: request.redirectUri,
        scope: request.scope.join(' '),
        state: request.state ?? null,
        nonce: request.nonce ?? null,
        codeChallenge: request.codeChallenge ?? null,
        codeChallengeMethod: request.codeChallengeMethod ?? null,
      },
    };
  }

  private successRedirect(request: ValidatedRequest, code: string): string {
    const params = new URLSearchParams();
    params.set('code', code);
    if (request.state !== undefined) params.set('state', request.state);
    return this.append(request.redirectUri, params);
  }

  private errorRedirect(
    request: Pick<ValidatedRequest, 'redirectUri' | 'state'>,
    error: string,
    description: string,
  ): AuthorizeOutcome {
    const params = new URLSearchParams();
    params.set('error', error);
    params.set('error_description', description);
    if (request.state !== undefined) params.set('state', request.state);
    return { kind: 'redirect', location: this.append(request.redirectUri, params) };
  }

  private append(uri: string, params: URLSearchParams): string {
    const url = new URL(uri);
    for (const [key, value] of params) url.searchParams.set(key, value);
    return url.toString();
  }

  private errorPage(error: string, description: string): Validation {
    return {
      kind: 'invalid',
      outcome: { kind: 'error-page', status: 400, error, errorDescription: description },
    };
  }

  /** State and nonce are echoed exactly as the client sent them. */
  private verbatim(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}

function deviceOf(session: SsoSession): ActingDevice {
  return { sessionId: session.id, identityId: session.identityId, email: session.email };
}
