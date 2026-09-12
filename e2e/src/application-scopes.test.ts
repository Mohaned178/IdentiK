import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Per-Application scopes (ADR-0016): scopes are integration configuration
 * governing token contents, not user-granted permissions. Each Application
 * carries an allowed scope set; the authorization endpoint serves only what
 * the Application was configured for, and a widening or narrowing is an
 * audit-logged Management API change. Observed only through Seam 1 (HTTP) and
 * Seam 2 (captured email).
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'member password 123', name: 'Layla' };
const MOHAMED = { email: 'mohamed@example.com', password: 'end user password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';

interface ApplicationView {
  id: string;
  clientId: string;
  allowedScopes: string[];
}

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  actorName: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
}

function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in email body');
  return match[0];
}

function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error(`no token in link: ${link}`);
  return token;
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('Per-Application scopes: integration configuration governing token contents', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let zotac: { id: string; clientId: string; secret: string };

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  const appDetail = async (id = zotac.id): Promise<ApplicationView> => {
    const res = await instance.request(`/api/applications/${id}`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { application: ApplicationView }).application;
  };

  const configure = (scopes: unknown, cookie = memberCookie): Promise<Response> =>
    instance.request(`/api/applications/${zotac.id}/scopes`, {
      method: 'PUT',
      headers: { cookie },
      body: { scopes },
      redirect: 'manual',
    });

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  /** POST the hosted sign-in form; return the response unexchanged. */
  const authorize = (scope: string): Promise<Response> => {
    const { challenge } = pkce();
    return instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: zotac.clientId,
        redirect_uri: ZOTAC_REDIRECT,
        response_type: 'code',
        scope,
        state: randomBytes(8).toString('base64url'),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      body: { email: MOHAMED.email, password: MOHAMED.password },
    });
  };

  const authorizeAndExchange = async (scope: string): Promise<TokenResponse> => {
    const { verifier, challenge } = pkce();
    const res = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: zotac.clientId,
        redirect_uri: ZOTAC_REDIRECT,
        response_type: 'code',
        scope,
        state: randomBytes(8).toString('base64url'),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      body: { email: MOHAMED.email, password: MOHAMED.password },
    });
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get('location')!).searchParams.get('code');
    if (!code) throw new Error(`no code in redirect: ${res.headers.get('location')}`);
    const exchanged = await instance.request('/api/oidc/token', {
      method: 'POST',
      redirect: 'manual',
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: ZOTAC_REDIRECT,
        client_id: zotac.clientId,
        client_secret: zotac.secret,
        code_verifier: verifier,
      },
    });
    expect(exchanged.status).toBe(200);
    return (await exchanged.json()) as TokenResponse;
  };

  const refresh = (refreshToken: string, scope?: string): Promise<Response> =>
    instance.request('/api/oidc/token', {
      method: 'POST',
      redirect: 'manual',
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: zotac.clientId,
        client_secret: zotac.secret,
        ...(scope ? { scope } : {}),
      },
    });

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);

    const ceremony = await instance.request('/api/setup', {
      method: 'POST',
      query: { token: instance.setupToken() },
      body: { organizationName: ORGANIZATION_NAME, ...OWNER },
    });
    expect(ceremony.status).toBe(201);

    const owner = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(owner.status).toBe(200);
    ownerCookie = cookieFrom(owner);

    const invited = await instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { email: MEMBER.email, role: 'member' },
    });
    expect(invited.status).toBe(201);
    const invitationMail = (await instance.capturedEmails()).find(
      (mail) => mail.to === MEMBER.email && /invit/i.test(mail.subject),
    );
    const accept = await instance.request('/api/administrators/invitations/accept', {
      method: 'POST',
      body: { token: tokenFromLink(linkFromBody(invitationMail!.body)), ...MEMBER },
    });
    expect(accept.status).toBe(201);
    const member = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: MEMBER.email, password: MEMBER.password },
    });
    expect(member.status).toBe(200);
    memberCookie = cookieFrom(member);

    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Zotac', type: 'web' },
    });
    expect(registered.status).toBe(201);
    const body = (await registered.json()) as {
      application: ApplicationView;
      clientSecret: string;
    };
    zotac = {
      id: body.application.id,
      clientId: body.application.clientId,
      secret: body.clientSecret,
    };
    const added = await instance.request(`/api/applications/${zotac.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: ZOTAC_REDIRECT },
    });
    expect(added.status).toBe(201);

    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: MOHAMED,
    });
    expect(signUp.status).toBe(201);
    const mail = (await instance.capturedEmails())
      .filter((entry) => entry.to === MOHAMED.email && /verify/i.test(entry.subject))
      .at(-1);
    const verified = await fetch(linkFromBody(mail!.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('a new Application starts with the full supported scope set', async () => {
    expect(await appDetail()).toMatchObject({
      allowedScopes: ['openid', 'email', 'profile'],
    });
  });

  it('an Administrator configures the set, with the change audited; repeating it is a no-op', async () => {
    // Scopes are day-to-day integration state, so a Member configures them.
    const configured = await configure(['openid', 'email']);
    expect(configured.status).toBe(200);
    expect(
      ((await configured.json()) as { application: ApplicationView }).application.allowedScopes,
    ).toEqual(['openid', 'email']);

    const event = (await auditEvents()).find(
      (entry) =>
        entry.kind === 'application.scopes.updated' && entry.detail.applicationId === zotac.id,
    );
    expect(event).toBeDefined();
    expect(event!.actor).toBeTruthy();
    expect(event!.actorName).toBe(MEMBER.name);
    expect(event!.detail).toMatchObject({
      previousScopes: ['openid', 'email', 'profile'],
      scopes: ['openid', 'email'],
    });

    const again = await configure(['openid', 'email']);
    expect(again.status).toBe(200);
    const events = (await auditEvents()).filter(
      (entry) =>
        entry.kind === 'application.scopes.updated' && entry.detail.applicationId === zotac.id,
    );
    expect(events).toHaveLength(1);
  });

  it('refuses a scope the Application was not configured for', async () => {
    const refused = await authorize('openid profile');
    expect(refused.status).toBe(302);
    const error = new URL(refused.headers.get('location')!).searchParams.get('error');
    expect(error).toBe('invalid_scope');

    const allowed = await authorize('openid email');
    expect(allowed.status).toBe(302);
    expect(new URL(allowed.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  it('serves token contents for the configured scopes only', async () => {
    const tokens = await authorizeAndExchange('openid email');
    const claims = decodeJwt(tokens.id_token);
    expect(claims.email).toBe(MOHAMED.email);
    expect(claims.email_verified).toBe(true);
    expect(claims.preferred_username).toBeUndefined();

    const userinfo = await instance.request('/api/oidc/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(200);
    const profile = (await userinfo.json()) as Record<string, unknown>;
    expect(profile).toMatchObject({ email: MOHAMED.email, email_verified: true });
    expect(profile).not.toHaveProperty('preferred_username');

    // A refresh may still only narrow the original grant: the refused scope
    // was never configured, so it cannot be introduced at refresh either.
    const widened = await refresh(tokens.refresh_token, 'openid profile');
    expect(widened.status).toBe(400);
    expect(((await widened.json()) as { error: string }).error).toBe('invalid_scope');

    const narrowed = await refresh(tokens.refresh_token, 'openid');
    expect(narrowed.status).toBe(200);
    const narrowedClaims = decodeJwt(((await narrowed.json()) as TokenResponse).id_token);
    expect(narrowedClaims.sub).toBeTruthy();
    expect(narrowedClaims.email).toBeUndefined();
  });

  it('validates the configured value and Administrator access', async () => {
    const anonymous = await instance.request(`/api/applications/${zotac.id}/scopes`, {
      method: 'PUT',
      body: { scopes: ['openid'] },
      redirect: 'manual',
    });
    expect(anonymous.status).toBe(401);

    for (const scopes of [['openid', 'admin'], ['email'], [], 'openid email profile']) {
      const res = await configure(scopes);
      expect(res.status, JSON.stringify(scopes)).toBe(400);
    }
    expect((await appDetail()).allowedScopes).toEqual(['openid', 'email']);

    const unknown = await instance.request('/api/applications/no-such-application/scopes', {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: { scopes: ['openid'] },
      redirect: 'manual',
    });
    expect(unknown.status).toBe(404);
  });

  it('narrowing the configured set bites already-granted refresh tokens', async () => {
    const tokens = await authorizeAndExchange('openid email');

    const narrowed = await configure(['openid']);
    expect(narrowed.status).toBe(200);

    // The grant is wider than the Application is now configured for: a plain
    // refresh is refused rather than minting removed claims forever.
    const refused = await refresh(tokens.refresh_token);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('invalid_scope');

    // Explicitly narrowing into the configured set recovers the grant.
    const recovered = await refresh(tokens.refresh_token, 'openid');
    expect(recovered.status).toBe(200);
    expect(decodeJwt(((await recovered.json()) as TokenResponse).id_token).email).toBeUndefined();
  });

  it('re-widening restores the wider claims', async () => {
    const configured = await configure(['openid', 'email', 'profile'], ownerCookie);
    expect(configured.status).toBe(200);
    expect((await appDetail()).allowedScopes).toEqual(['openid', 'email', 'profile']);

    const tokens = await authorizeAndExchange('openid profile');
    const claims = decodeJwt(tokens.id_token);
    expect(claims.preferred_username).toBe(MOHAMED.email);
    expect(claims.email).toBeUndefined();
  });
});
