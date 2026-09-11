import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 09 — The authorization endpoint, the SSO Session, and silent
 * Enrollment (ADR-0013, ADR-0014, ADR-0015). Observed only through Seam 1
 * (HTTP) and Seam 2 (captured email).
 *
 * An Application redirects the End User to /api/oidc/authorize. Client and
 * redirect URI are validated before anything else: a bad client or an
 * unregistered URI gets an error page and is never redirected to. After
 * that, protocol errors (response type, scope, PKCE) redirect back with the
 * OAuth error. A verified Identity signs in on the hosted page, which creates
 * the Session (the SSO cookie) and silently enrolls them in the Application —
 * no consent screen — then redirects with a single-use code and the echoed
 * state. A live Session is reused on another Application's authorize request
 * without a password. Failed attempts are audited with source and target.
 *
 * Deferred by dependency, not forgotten: code consumption/replay/expiry is
 * ticket 10's token exchange, and the suspension actions that set the gates
 * this endpoint honors arrive in ticket 13 (which tests them here).
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const UNVERIFIED = { email: 'layla@example.com', password: 'unverified password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const MOBILE_REDIRECT = 'https://mobile.example.com/callback';
const PKCE_CHALLENGE = 'A'.repeat(43);

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface ApplicationView {
  id: string;
  clientId: string;
}

interface SignInPage {
  organizationName: string;
  applicationName: string;
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

function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in email body');
  return match[0];
}

function tokenFromLink(link: string): string {
  const parsed = new URL(link);
  const token = parsed.searchParams.get('token');
  if (!token) throw new Error(`no token in link: ${link}`);
  return token;
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('Authorization endpoint, SSO Session, silent Enrollment', () => {
  let instance: Instance;
  let ownerCookie: string;
  let zotacId: string;
  let mobileId: string;
  let zotacClientId: string;
  let mobileClientId: string;
  let ssoCookie: string;

  const authorize = (
    query: Record<string, string>,
    init: { method?: string; body?: unknown; cookie?: string } = {},
  ): Promise<Response> =>
    instance.request('/api/oidc/authorize', {
      method: init.method ?? 'GET',
      query,
      body: init.body,
      redirect: 'manual',
      headers: init.cookie ? { cookie: init.cookie } : undefined,
    });

  const zotacRequest = (overrides: Record<string, string> = {}): Record<string, string> => ({
    client_id: zotacClientId,
    redirect_uri: ZOTAC_REDIRECT,
    response_type: 'code',
    scope: 'openid email profile',
    state: 'state-123',
    ...overrides,
  });

  const locationParams = (res: Response): URLSearchParams => {
    const location = res.headers.get('location');
    if (!location) throw new Error(`no Location header on ${res.status}`);
    return new URL(location).searchParams;
  };

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  const registerApplication = async (
    name: string,
    type: 'web' | 'spa',
    redirectUri: string,
  ): Promise<{ id: string; clientId: string }> => {
    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name, type },
    });
    expect(registered.status).toBe(201);
    const application = ((await registered.json()) as { application: ApplicationView }).application;
    const added = await instance.request(`/api/applications/${application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: redirectUri },
    });
    expect(added.status).toBe(201);
    return { id: application.id, clientId: application.clientId };
  };

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);

    const match = [...instance.consoleLog().matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1);
    if (!match) throw new Error('no setup token in console output');
    const ceremony = await instance.request('/api/setup', {
      method: 'POST',
      query: { token: match[1] },
      body: { organizationName: ORGANIZATION_NAME, ...OWNER },
    });
    expect(ceremony.status).toBe(201);

    const owner = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(owner.status).toBe(200);
    ownerCookie = cookieFrom(owner);

    const zotac = await registerApplication('Zotac', 'web', ZOTAC_REDIRECT);
    zotacId = zotac.id;
    zotacClientId = zotac.clientId;
    const mobile = await registerApplication('Mobile', 'spa', MOBILE_REDIRECT);
    mobileId = mobile.id;
    mobileClientId = mobile.clientId;

    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: END_USER,
    });
    expect(signUp.status).toBe(201);
    const verificationMail = (await instance.capturedEmails()).find(
      (mail) => mail.to === END_USER.email && /verify/i.test(mail.subject),
    );
    const verified = await fetch(linkFromBody(verificationMail!.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);

    const unverified = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: UNVERIFIED,
    });
    expect(unverified.status).toBe(201);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('an unknown Client ID is refused without any redirect', async () => {
    const res = await authorize(zotacRequest({ client_id: 'client-does-not-exist' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
  });

  it('an unregistered or mismatched redirect URI is refused without any redirect', async () => {
    for (const redirect_uri of [
      'https://zotac.example.com/oidc/callback/extra',
      'https://zotac.example.com/oidc/other',
      'https://evil.example.com/oidc/callback',
      'https://zotac.example.com:8443/oidc/callback',
      'http://zotac.example.com/oidc/callback',
      'not-a-uri',
    ]) {
      const res = await authorize(zotacRequest({ redirect_uri }));
      expect(res.status, redirect_uri).toBe(400);
      expect(res.headers.get('location'), redirect_uri).toBeNull();
      expect(((await res.json()) as { error: string }).error, redirect_uri).toBe(
        'invalid_redirect_uri',
      );
    }
  });

  it('the hosted sign-in page carries the Organization, Application, and validated request', async () => {
    const res = await authorize(zotacRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();

    const page = (await res.json()) as SignInPage;
    expect(page.organizationName).toBe(ORGANIZATION_NAME);
    expect(page.applicationName).toBe('Zotac');
    expect(page.request).toMatchObject({
      clientId: zotacClientId,
      redirectUri: ZOTAC_REDIRECT,
      scope: 'openid email profile',
      state: 'state-123',
    });
  });

  it('an unsupported response type redirects the error back to the client', async () => {
    const res = await authorize(zotacRequest({ response_type: 'token' }));
    expect(res.status).toBe(302);
    const params = locationParams(res);
    expect(params.get('error')).toBe('unsupported_response_type');
    expect(params.get('state')).toBe('state-123');
    expect(params.get('code')).toBeNull();
  });

  it('a scope shape the platform does not serve is refused', async () => {
    for (const scope of ['openid unknown_scope', 'email profile', '']) {
      const res = await authorize(zotacRequest({ scope }));
      expect(res.status, JSON.stringify(scope)).toBe(302);
      const params = locationParams(res);
      expect(params.get('error'), JSON.stringify(scope)).toBe('invalid_scope');
      expect(params.get('state')).toBe('state-123');
    }
  });

  it('a public client must present an S256 PKCE challenge', async () => {
    const base = {
      client_id: mobileClientId,
      redirect_uri: MOBILE_REDIRECT,
      response_type: 'code',
      scope: 'openid',
      state: 'mobile-state',
    };

    const missing = await authorize(base);
    expect(missing.status).toBe(302);
    expect(locationParams(missing).get('error')).toBe('invalid_request');

    const plain = await authorize({
      ...base,
      code_challenge: PKCE_CHALLENGE,
      code_challenge_method: 'plain',
    });
    expect(plain.status).toBe(302);
    expect(locationParams(plain).get('error')).toBe('invalid_request');

    const malformed = await authorize({
      ...base,
      code_challenge: 'too-short',
      code_challenge_method: 'S256',
    });
    expect(malformed.status).toBe(302);
    expect(locationParams(malformed).get('error')).toBe('invalid_request');

    const good = await authorize({
      ...base,
      code_challenge: PKCE_CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(good.status).toBe(200);
    expect(((await good.json()) as SignInPage).applicationName).toBe('Mobile');
  });

  it('the S256 challenge shape is enforced for confidential clients too when presented', async () => {
    const res = await authorize(
      zotacRequest({ code_challenge: PKCE_CHALLENGE, code_challenge_method: 'plain' }),
    );
    expect(res.status).toBe(302);
    expect(locationParams(res).get('error')).toBe('invalid_request');
  });

  it('an invalid SSO cookie is treated as no session', async () => {
    const res = await authorize(zotacRequest(), { cookie: 'identik_sso_session=not-a-real-token' });
    expect(res.status).toBe(200);
  });

  it('a tampered POST is refused before credentials are considered', async () => {
    const res = await authorize(
      zotacRequest({ redirect_uri: 'https://evil.example.com/callback' }),
      { method: 'POST', body: { email: END_USER.email, password: END_USER.password } },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('bad credentials and unknown emails are refused uniformly', async () => {
    const wrong = await authorize(zotacRequest(), {
      method: 'POST',
      body: { email: END_USER.email, password: 'the wrong password' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect(wrong.headers.get('location')).toBeNull();
    const body = (await wrong.json()) as { error: string };
    expect(body).toEqual({ error: 'invalid_credentials' });

    const unknown = await authorize(zotacRequest(), {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'some password' },
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(body);
  });

  it('an unverified reservation cannot sign in', async () => {
    const res = await authorize(zotacRequest(), {
      method: 'POST',
      body: { email: UNVERIFIED.email, password: UNVERIFIED.password },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('failed attempts are audited with source and targeted Identity', async () => {
    const failures = (await auditEvents()).filter(
      (event) => event.kind === 'identity.sign_in.failed',
    );

    const wrongPassword = failures.find((event) => event.detail.email === END_USER.email);
    expect(wrongPassword).toBeDefined();
    expect(wrongPassword!.detail).toMatchObject({
      email: END_USER.email,
      reason: 'invalid',
      applicationId: zotacId,
    });
    expect(wrongPassword!.detail.source).toBeTruthy();

    const unknownEmail = failures.find((event) => event.detail.email === 'nobody@example.com');
    expect(unknownEmail).toBeDefined();
    expect(unknownEmail!.detail.source).toBeTruthy();

    const unverified = failures.find((event) => event.detail.email === UNVERIFIED.email);
    expect(unverified).toBeDefined();
    expect(unverified!.detail).toMatchObject({ email: UNVERIFIED.email, reason: 'unverified' });
  });

  it('a verified Identity signs in and receives a Session cookie, silent Enrollment, and a code', async () => {
    const res = await authorize(zotacRequest(), {
      method: 'POST',
      body: { email: END_USER.email, password: END_USER.password },
    });
    expect(res.status).toBe(302);

    const params = locationParams(res);
    expect(params.get('state')).toBe('state-123');
    expect(params.get('code')).toBeTruthy();

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^identik_sso_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    ssoCookie = setCookie.split(';')[0]!;

    const events = await auditEvents();
    const activated = events.find(
      (event) =>
        event.kind === 'identity.verification.completed' && event.detail.email === END_USER.email,
    );
    const identityId = activated!.detail.identityId as string;

    const enrollments = events.filter(
      (event) => event.kind === 'enrollment.created' && event.detail.applicationId === zotacId,
    );
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]!.detail).toMatchObject({
      applicationId: zotacId,
      identityId,
      email: END_USER.email,
    });
  });

  it('a live Session signs in to a second Application without a password, enrolling silently', async () => {
    expect(ssoCookie).toBeTruthy();

    const second = await authorize(
      {
        client_id: mobileClientId,
        redirect_uri: MOBILE_REDIRECT,
        response_type: 'code',
        scope: 'openid',
        state: 'mobile-second-visit',
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: 'S256',
      },
      { cookie: ssoCookie },
    );
    expect(second.status).toBe(302);
    expect(locationParams(second).get('state')).toBe('mobile-second-visit');
    expect(locationParams(second).get('code')).toBeTruthy();

    const again = await authorize(zotacRequest({ state: 'second-visit' }), { cookie: ssoCookie });
    expect(again.status).toBe(302);
    expect(locationParams(again).get('state')).toBe('second-visit');
    expect(locationParams(again).get('code')).toBeTruthy();

    const events = await auditEvents();
    expect(
      events.filter(
        (event) => event.kind === 'enrollment.created' && event.detail.applicationId === zotacId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.kind === 'enrollment.created' && event.detail.applicationId === mobileId,
      ),
    ).toHaveLength(1);
  });

  it('every authorization issues a fresh code', async () => {
    const first = await authorize(zotacRequest({ state: 'code-a' }), { cookie: ssoCookie });
    const second = await authorize(zotacRequest({ state: 'code-b' }), { cookie: ssoCookie });
    expect(locationParams(first).get('code')).not.toBe(locationParams(second).get('code'));
  });

  it('state is optional: when absent, none is echoed', async () => {
    const res = await authorize(
      {
        client_id: zotacClientId,
        redirect_uri: ZOTAC_REDIRECT,
        response_type: 'code',
        scope: 'openid',
      },
      { cookie: ssoCookie },
    );
    expect(res.status).toBe(302);
    expect(locationParams(res).has('state')).toBe(false);
  });
});
