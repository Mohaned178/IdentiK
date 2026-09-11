import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 11 — The Account Center (ADR-0013, ADR-0014, ADR-0018). Observed
 * only through Seam 1 (HTTP): an authenticated End User reaches a
 * platform-hosted surface listing their active Sessions with recognizable
 * device metadata, revokes one (or signs out, which revokes the current one),
 * and sees their Enrollments as an informational connected-Applications list.
 * Revocation is observable from outside: the revoked device's SSO cookie stops
 * resolving and every descendant refresh token in its lineage is refused.
 * Revocation events land in the unified audit surface.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const OTHER_USER = { email: 'layla@example.com', password: 'other user password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const MOBILE_REDIRECT = 'https://mobile.example.com/callback';

const DEVICE_ZOTAC = 'ZotacBrowser/1.0 (Windows NT 10.0; Win64; x64)';
const DEVICE_MOBILE = 'MobileDevice/7 (Android 15)';
const DEVICE_OTHER = 'OtherBrowser/3 (macOS 15)';

interface AccountCenterView {
  organizationName: string;
  identity: { email: string };
  currentSessionId: string;
  sessions: Array<{
    id: string;
    device: string | null;
    createdAt: string;
    lastSeenAt: string;
    current: boolean;
  }>;
  connectedApplications: Array<{
    applicationId: string;
    name: string;
    type: string;
    enrolledAt: string;
    suspended: boolean;
  }>;
}

interface ApplicationView {
  id: string;
  clientId: string;
}

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in email body');
  return match[0];
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('Account Center: Sessions, revocation, sign-out, connected Applications', () => {
  let instance: Instance;
  let ownerCookie: string;
  let zotac: { id: string; clientId: string; secret: string };
  let mobile: { id: string; clientId: string };

  let zotacCookie: string;
  let zotacSessionId: string;
  let zotacRefresh: string;
  let zotacMobileRefresh: string;
  let mobileCookie: string;
  let mobileSessionId: string;
  let mobileRotatedRefresh: string;
  let otherCookie: string;
  let otherSessionId: string;

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return {
      verifier,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
  };

  const registerApplication = async (
    name: string,
    type: 'web' | 'spa',
    redirectUri: string,
  ): Promise<{ id: string; clientId: string; secret: string }> => {
    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name, type },
    });
    expect(registered.status).toBe(201);
    const body = (await registered.json()) as {
      application: ApplicationView;
      clientSecret: string | null;
    };
    const added = await instance.request(`/api/applications/${body.application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: redirectUri },
    });
    expect(added.status).toBe(201);
    return {
      id: body.application.id,
      clientId: body.application.clientId,
      secret: body.clientSecret ?? '',
    };
  };

  const signUpAndVerify = async (endUser: { email: string; password: string }): Promise<void> => {
    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: endUser,
    });
    expect(signUp.status).toBe(201);
    const mail = (await instance.capturedEmails())
      .filter((entry) => entry.to === endUser.email && /verify/i.test(entry.subject))
      .at(-1);
    if (!mail) throw new Error(`no verification mail for ${endUser.email}`);
    const verified = await fetch(linkFromBody(mail.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);
  };

  const signIn = async (options: {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    device: string;
    email: string;
    password: string;
  }): Promise<{ code: string; cookie: string }> => {
    const res = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: randomBytes(8).toString('base64url'),
        ...(options.codeChallenge
          ? { code_challenge: options.codeChallenge, code_challenge_method: 'S256' }
          : {}),
      },
      body: { email: options.email, password: options.password },
      headers: { 'user-agent': options.device },
    });
    if (res.status !== 302) {
      throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
    }
    const location = new URL(res.headers.get('location')!);
    const code = location.searchParams.get('code');
    if (!code) throw new Error(`no code in ${location}`);
    return { code, cookie: cookieFrom(res) };
  };

  const exchange = (form: Record<string, string>, headers?: Record<string, string>) =>
    instance.request('/api/oidc/token', {
      method: 'POST',
      form,
      headers,
      redirect: 'manual',
    });

  const exchangeCode = async (options: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    verifier?: string;
  }): Promise<TokenResponse> => {
    const res = await exchange(
      {
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
        ...(options.verifier ? { code_verifier: options.verifier } : {}),
      },
      options.clientSecret ? {} : undefined,
    );
    const body = (await res.json()) as TokenResponse;
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body;
  };

  const refresh = (
    refreshToken: string,
    client: { clientId: string; secret?: string },
  ): Promise<Response> =>
    exchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      ...(client.secret ? { client_secret: client.secret } : {}),
    });

  const accountCenter = (cookie?: string): Promise<Response> =>
    instance.request('/api/account-center', {
      headers: cookie ? { cookie } : undefined,
      redirect: 'manual',
    });

  const accountCenterView = async (cookie: string): Promise<AccountCenterView> => {
    const res = await accountCenter(cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as AccountCenterView;
  };

  const revoke = (sessionId: string, cookie: string): Promise<Response> =>
    instance.request(`/api/account-center/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });

  const signOut = (cookie?: string): Promise<Response> =>
    instance.request('/api/account-center/sign-out', {
      method: 'POST',
      headers: cookie ? { cookie } : undefined,
      redirect: 'manual',
    });

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
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

    zotac = await registerApplication('Zotac', 'web', ZOTAC_REDIRECT);
    mobile = await registerApplication('Mobile', 'spa', MOBILE_REDIRECT);

    await signUpAndVerify(END_USER);
    await signUpAndVerify(OTHER_USER);

    // Device A: the web Application, confidential client.
    const zotacSignIn = await signIn({
      clientId: zotac.clientId,
      redirectUri: ZOTAC_REDIRECT,
      device: DEVICE_ZOTAC,
      email: END_USER.email,
      password: END_USER.password,
    });
    zotacCookie = zotacSignIn.cookie;
    zotacRefresh = (
      await exchangeCode({
        code: zotacSignIn.code,
        redirectUri: ZOTAC_REDIRECT,
        clientId: zotac.clientId,
        clientSecret: zotac.secret,
      })
    ).refresh_token;

    // The same Session reaches a second Application through SSO, so its
    // refresh lineage spans Applications — the ADR-0013 parentage under test.
    const crossAppPkce = pkce();
    const crossApp = await instance.request('/api/oidc/authorize', {
      redirect: 'manual',
      query: {
        client_id: mobile.clientId,
        redirect_uri: MOBILE_REDIRECT,
        response_type: 'code',
        scope: 'openid email',
        state: 'cross-app',
        code_challenge: crossAppPkce.challenge,
        code_challenge_method: 'S256',
      },
      headers: { cookie: zotacCookie },
    });
    expect(crossApp.status).toBe(302);
    const crossAppCode = new URL(crossApp.headers.get('location')!).searchParams.get('code')!;
    zotacMobileRefresh = (
      await exchangeCode({
        code: crossAppCode,
        redirectUri: MOBILE_REDIRECT,
        clientId: mobile.clientId,
        verifier: crossAppPkce.verifier,
      })
    ).refresh_token;

    // Device B: the public client, with PKCE, and a rotated refresh lineage.
    const mobilePkce = pkce();
    const mobileSignIn = await signIn({
      clientId: mobile.clientId,
      redirectUri: MOBILE_REDIRECT,
      codeChallenge: mobilePkce.challenge,
      device: DEVICE_MOBILE,
      email: END_USER.email,
      password: END_USER.password,
    });
    mobileCookie = mobileSignIn.cookie;
    const mobileTokens = await exchangeCode({
      code: mobileSignIn.code,
      redirectUri: MOBILE_REDIRECT,
      clientId: mobile.clientId,
      verifier: mobilePkce.verifier,
    });
    const mobileRotated = await refresh(mobileTokens.refresh_token, {
      clientId: mobile.clientId,
    });
    expect(mobileRotated.status).toBe(200);
    mobileRotatedRefresh = ((await mobileRotated.json()) as TokenResponse).refresh_token;

    // A third device belonging to a different Identity.
    const otherSignIn = await signIn({
      clientId: zotac.clientId,
      redirectUri: ZOTAC_REDIRECT,
      device: DEVICE_OTHER,
      email: OTHER_USER.email,
      password: OTHER_USER.password,
    });
    otherCookie = otherSignIn.cookie;

    const endUserView = await accountCenterView(zotacCookie);
    zotacSessionId = endUserView.sessions.find((session) => session.current)!.id;
    const otherView = await accountCenterView(otherCookie);
    otherSessionId = otherView.sessions.find((session) => session.current)!.id;
    mobileSessionId = endUserView.sessions.find(
      (session) => session.device === DEVICE_MOBILE,
    )!.id;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('refuses an unauthenticated visitor', async () => {
    const anonymous = await accountCenter();
    expect(anonymous.status).toBe(401);

    const garbage = await accountCenter('identik_sso_session=not-a-real-token');
    expect(garbage.status).toBe(401);
  });

  it('lists active Sessions with recognizable device metadata', async () => {
    const page = await accountCenterView(zotacCookie);

    expect(page.organizationName).toBe(ORGANIZATION_NAME);
    expect(page.identity.email).toBe(END_USER.email);
    expect(page.currentSessionId).toBe(zotacSessionId);

    expect(page.sessions).toHaveLength(2);
    const devices = page.sessions.map((session) => session.device);
    expect(devices).toContain(DEVICE_ZOTAC);
    expect(devices).toContain(DEVICE_MOBILE);

    const current = page.sessions.filter((session) => session.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(zotacSessionId);
    expect(current[0]!.device).toBe(DEVICE_ZOTAC);

    for (const session of page.sessions) {
      expect(typeof session.createdAt).toBe('string');
      expect(typeof session.lastSeenAt).toBe('string');
      expect(Number.isNaN(Date.parse(session.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(session.lastSeenAt))).toBe(false);
    }
  });

  it('shows connected Applications as an informational Enrollment list', async () => {
    const page = await accountCenterView(zotacCookie);

    const zotacEntry = page.connectedApplications.find(
      (application) => application.applicationId === zotac.id,
    );
    const mobileEntry = page.connectedApplications.find(
      (application) => application.applicationId === mobile.id,
    );
    expect(zotacEntry).toMatchObject({ name: 'Zotac', type: 'web', suspended: false });
    expect(mobileEntry).toMatchObject({ name: 'Mobile', type: 'spa', suspended: false });
    expect(Number.isNaN(Date.parse(zotacEntry!.enrolledAt))).toBe(false);

    // Informational only: no End-User un-enroll surface exists.
    const unenroll = await instance.request(
      `/api/account-center/applications/${zotac.id}/unenroll`,
      { method: 'POST', headers: { cookie: zotacCookie } },
    );
    expect(unenroll.status).toBe(404);
  });

  it('revoking another Session kills its cookie and its refresh lineage immediately', async () => {
    const revoked = await revoke(mobileSessionId, zotacCookie);
    expect(revoked.status).toBe(200);

    const deadCookie = await accountCenter(mobileCookie);
    expect(deadCookie.status).toBe(401);

    const deadRefresh = await refresh(mobileRotatedRefresh, { clientId: mobile.clientId });
    expect(deadRefresh.status).toBe(400);
    expect(((await deadRefresh.json()) as { error: string }).error).toBe('invalid_grant');

    const verdict = await instance.request('/api/oidc/introspect', {
      method: 'POST',
      form: { token: mobileRotatedRefresh, client_id: mobile.clientId },
      redirect: 'manual',
    });
    expect(await verdict.json()).toEqual({ active: false });

    const remaining = await accountCenterView(zotacCookie);
    expect(remaining.sessions.map((session) => session.id)).toEqual([zotacSessionId]);

    // The surviving device's lineage is untouched.
    const survivor = await refresh(zotacRefresh, {
      clientId: zotac.clientId,
      secret: zotac.secret,
    });
    expect(survivor.status).toBe(200);
    zotacRefresh = ((await survivor.json()) as TokenResponse).refresh_token;
  });

  it('is idempotent about revoking an already-revoked Session', async () => {
    const again = await revoke(mobileSessionId, zotacCookie);
    expect(again.status).toBe(200);
  });

  it('refuses to revoke a Session that belongs to another Identity', async () => {
    const forbidden = await revoke(otherSessionId, zotacCookie);
    expect(forbidden.status).toBe(404);

    const unknown = await revoke('no-such-session', zotacCookie);
    expect(unknown.status).toBe(404);

    const stillThere = await accountCenterView(otherCookie);
    expect(stillThere.currentSessionId).toBe(otherSessionId);
  });

  it('sign-out revokes the current Session and clears the cookie', async () => {
    const signedOut = await signOut(zotacCookie);
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get('set-cookie')).toContain('identik_sso_session=;');

    const deadCookie = await accountCenter(zotacCookie);
    expect(deadCookie.status).toBe(401);

    const deadRefresh = await refresh(zotacRefresh, {
      clientId: zotac.clientId,
      secret: zotac.secret,
    });
    expect(deadRefresh.status).toBe(400);
    expect(((await deadRefresh.json()) as { error: string }).error).toBe('invalid_grant');

    // The cascade crosses Applications: the Mobile-issued child of the same
    // Session dies too, not just the lineage of the Application that signed in.
    const deadCrossApp = await refresh(zotacMobileRefresh, { clientId: mobile.clientId });
    expect(deadCrossApp.status).toBe(400);
    expect(((await deadCrossApp.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('sign-out outside a Session is uniform and clears any stale cookie', async () => {
    const anonymous = await signOut();
    expect(anonymous.status).toBe(204);
    expect(anonymous.headers.get('set-cookie')).toContain('identik_sso_session=;');
  });

  it('records Session revocations as audit events', async () => {
    const revocations = (await auditEvents()).filter(
      (event) => event.kind === 'session.revoked',
    );

    const accountCenterRevoke = revocations.find(
      (event) => event.detail.sessionId === mobileSessionId,
    );
    expect(accountCenterRevoke).toBeDefined();
    expect(accountCenterRevoke!.actor).toBe('end-user');
    expect(accountCenterRevoke!.detail).toMatchObject({
      sessionId: mobileSessionId,
      reason: 'account_center',
    });

    const signOutRevoke = revocations.find((event) => event.detail.sessionId === zotacSessionId);
    expect(signOutRevoke).toBeDefined();
    expect(signOutRevoke!.detail).toMatchObject({
      sessionId: zotacSessionId,
      reason: 'sign_out',
    });
  });
});
