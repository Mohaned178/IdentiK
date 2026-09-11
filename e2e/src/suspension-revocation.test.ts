import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 13 — Two-level suspension and revoke-all-Sessions (ADR-0006,
 * ADR-0008, ADR-0013). Observed only through Seam 1 (HTTP): the Management
 * API's levers, the hosted authorization endpoint, the token endpoint, and
 * introspection. No test inspects the database or token internals.
 *
 * Two distinct reversibles: suspending from an Application loses one
 * Application, suspending an Identity loses the Organization; both kill the
 * platform's live Sessions within the request and revoke every descendant
 * refresh token, while access tokens stay untracked and die within their
 * short TTL. Revoke-all-Sessions evicts every device at once. Every lever is
 * an Administrator (Member included) action and an audit event.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'member password 123', name: 'Layla' };
const MOHAMED = { email: 'mohamed@example.com', password: 'end user password 123' };
const OMAR = { email: 'omar@example.com', password: 'other user password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const MOBILE_REDIRECT = 'https://mobile.example.com/callback';

interface ApplicationView {
  id: string;
  clientId: string;
}

interface IdentityListItem {
  id: string;
  email: string;
  state: string;
}

interface EnrollmentView {
  applicationId: string;
  suspended: boolean;
}

interface SessionView {
  id: string;
  device: string | null;
}

interface ActivityView {
  kind: string;
  actor: string;
  actorName: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface IdentityDetail extends IdentityListItem {
  emailVerified: boolean;
  enrollments: EnrollmentView[];
  sessions: SessionView[];
  recentActivity: ActivityView[];
}

interface ApplicationEnrollmentView {
  identityId: string;
  email: string;
  emailVerified: boolean;
  state: string;
  suspended: boolean;
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
  expires_in: number;
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

describe('Two-level suspension and revoke-all-Sessions', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let zotac: ApplicationView;
  let mobile: ApplicationView;
  let mohamedId: string;
  let omarId: string;

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return {
      verifier,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
  };

  const adminPost = (path: string, cookie = ownerCookie): Promise<Response> =>
    instance.request(path, { method: 'POST', headers: { cookie }, redirect: 'manual' });

  const authorizationQuery = (application: ApplicationView, redirectUri: string) => ({
    client_id: application.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: randomBytes(8).toString('base64url'),
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  });

  /** POST the hosted sign-in form and return the redirect, cookie, verifier. */
  const signIn = async (options: {
    application: ApplicationView;
    redirectUri: string;
    email: string;
    password: string;
    device?: string;
    cookie?: string;
  }): Promise<{ status: number; location: string | null; cookie: string; verifier: string }> => {
    const { verifier, challenge } = pkce();
    const res = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: options.application.clientId,
        redirect_uri: options.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: randomBytes(8).toString('base64url'),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      body: { email: options.email, password: options.password },
      headers: {
        'user-agent': options.device ?? 'TestDevice/1.0',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
    return {
      status: res.status,
      location: res.headers.get('location'),
      cookie: cookieFrom(res),
      verifier,
    };
  };

  /** GET the authorization endpoint with an existing cookie (silent SSO). */
  const ssoBegin = (
    application: ApplicationView,
    redirectUri: string,
    cookie: string,
  ): Promise<Response> =>
    instance.request('/api/oidc/authorize', {
      redirect: 'manual',
      query: authorizationQuery(application, redirectUri),
      headers: { cookie },
    });

  const signInAndExchange = async (options: {
    application: ApplicationView;
    redirectUri: string;
    email: string;
    password: string;
    device?: string;
  }): Promise<{ cookie: string; tokens: TokenResponse }> => {
    const result = await signIn(options);
    expect(result.status).toBe(302);
    const code = result.location ? new URL(result.location).searchParams.get('code') : null;
    if (!code) throw new Error(`no authorization code in redirect: ${result.location}`);
    const exchanged = await instance.request('/api/oidc/token', {
      method: 'POST',
      redirect: 'manual',
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: options.redirectUri,
        client_id: options.application.clientId,
        code_verifier: result.verifier,
      },
    });
    expect(exchanged.status).toBe(200);
    return { cookie: result.cookie, tokens: (await exchanged.json()) as TokenResponse };
  };

  const refresh = (application: ApplicationView, refreshToken: string): Promise<Response> =>
    instance.request('/api/oidc/token', {
      method: 'POST',
      redirect: 'manual',
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: application.clientId,
      },
    });

  const introspect = (application: ApplicationView, token: string): Promise<Response> =>
    instance.request('/api/oidc/introspect', {
      method: 'POST',
      redirect: 'manual',
      form: { token, client_id: application.clientId },
    });

  const identityDetail = async (identityId: string): Promise<IdentityDetail> => {
    const res = await instance.request(`/api/identities/${identityId}`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { identity: IdentityDetail }).identity;
  };

  const applicationEnrollments = async (
    applicationId: string,
  ): Promise<ApplicationEnrollmentView[]> => {
    const res = await instance.request(`/api/applications/${applicationId}/enrollments`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { enrollments: ApplicationEnrollmentView[] }).enrollments;
  };

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  const registerApplication = async (
    name: string,
    redirectUri: string,
  ): Promise<ApplicationView> => {
    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name, type: 'spa' },
    });
    expect(registered.status).toBe(201);
    const application = ((await registered.json()) as { application: ApplicationView }).application;
    const added = await instance.request(`/api/applications/${application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: redirectUri },
    });
    expect(added.status).toBe(201);
    return application;
  };

  const signUp = async (endUser: { email: string; password: string }): Promise<void> => {
    const res = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: endUser,
    });
    expect(res.status).toBe(201);
  };

  const verify = async (email: string): Promise<void> => {
    const mail = (await instance.capturedEmails())
      .filter((entry) => entry.to === email && /verify/i.test(entry.subject))
      .at(-1);
    if (!mail) throw new Error(`no verification mail for ${email}`);
    const verified = await fetch(linkFromBody(mail.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);
  };

  beforeAll(async () => {
    // A short access-token TTL is the observation window for honest
    // propagation: untracked bearer tokens die on schedule, not on revoke.
    instance = await Instance.start(BACKEND_DIST, { IDENTIK_ACCESS_TOKEN_TTL_MS: '2000' });

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

    await instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { email: MEMBER.email, role: 'member' },
    });
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

    zotac = await registerApplication('Zotac', ZOTAC_REDIRECT);
    mobile = await registerApplication('Mobile', MOBILE_REDIRECT);

    await signUp(MOHAMED);
    await verify(MOHAMED.email);
    await signUp(OMAR);
    await verify(OMAR.email);

    const listed = await instance.request('/api/identities', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(listed.status).toBe(200);
    const identities = ((await listed.json()) as { identities: IdentityListItem[] }).identities;
    mohamedId = identities.find((identity) => identity.email === MOHAMED.email)!.id;
    omarId = identities.find((identity) => identity.email === OMAR.email)!.id;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('suspending an Identity kills Sessions immediately and refuses sign-in until unsuspended', async () => {
    const zotacSession = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...MOHAMED,
      device: 'MohamedLaptop/1.0',
    });
    const mobileSession = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...MOHAMED,
      device: 'MohamedPhone/1.0',
    });

    const suspended = await adminPost(`/api/identities/${mohamedId}/suspend`);
    expect(suspended.status).toBe(200);
    expect(
      ((await suspended.json()) as { identity: IdentityDetail }).identity,
    ).toMatchObject({
      id: mohamedId,
      email: MOHAMED.email,
      emailVerified: true,
      state: 'suspended',
    });

    // New authentication is refused Organization-wide, uniformly with bad
    // credentials — the suspended Identity never reaches the Enrollment gate.
    const refused = await signIn({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...MOHAMED,
    });
    expect(refused.status).toBe(401);

    // The live platform Session is dead within the request: the SSO cookie no
    // longer resolves and the same browser is sent back to the sign-in page.
    const deadCookie = await ssoBegin(mobile, MOBILE_REDIRECT, zotacSession.cookie);
    expect(deadCookie.status).toBe(200);
    expect((await deadCookie.json()) as Record<string, unknown>).toHaveProperty('request');

    // Descendant refresh tokens are revoked: every rotation is refused.
    for (const [application, session] of [
      [zotac, zotacSession],
      [mobile, mobileSession],
    ] as const) {
      const rotated = await refresh(application, session.tokens.refresh_token);
      expect(rotated.status).toBe(400);
      expect(((await rotated.json()) as { error: string }).error).toBe('invalid_grant');
    }

    // Introspection verdicts: the refresh token is dead, and the access token
    // is refused immediately because the platform checks Identity state at
    // ask-time — access tokens are untracked, but suspension is not.
    const refreshVerdict = await introspect(zotac, zotacSession.tokens.refresh_token);
    expect(await refreshVerdict.json()).toEqual({ active: false });
    const accessVerdict = await introspect(zotac, zotacSession.tokens.access_token);
    expect(await accessVerdict.json()).toEqual({ active: false });

    const events = await auditEvents();
    const suspensionEvent = events.find(
      (event) => event.kind === 'identity.suspended' && event.detail.identityId === mohamedId,
    );
    expect(suspensionEvent).toBeDefined();
    expect(suspensionEvent!.actorName).toBe(OWNER.name);
    expect(suspensionEvent!.detail).toMatchObject({ email: MOHAMED.email });

    // Session deaths are first-class audit events of the cascade.
    const sessionDeaths = events.filter(
      (event) => event.kind === 'session.revoked' && event.detail.identityId === mohamedId,
    );
    expect(sessionDeaths.length).toBeGreaterThanOrEqual(2);
    expect(
      sessionDeaths.every((event) => event.detail.reason === 'suspension'),
    ).toBe(true);

    // Reversible: unsuspend restores authentication.
    const unsuspended = await adminPost(`/api/identities/${mohamedId}/unsuspend`);
    expect(unsuspended.status).toBe(200);
    expect(
      ((await unsuspended.json()) as { identity: IdentityDetail }).identity.state,
    ).toBe('active');

    // Unsuspension never resurrects the killed Sessions — the cookie or its
    // refresh tokens. The Identity signs in again; the cascade is permanent.
    const stillDead = await ssoBegin(zotac, ZOTAC_REDIRECT, zotacSession.cookie);
    expect(stillDead.status).toBe(200);
    expect((await stillDead.json()) as Record<string, unknown>).toHaveProperty('request');
    const stillRevoked = await refresh(zotac, zotacSession.tokens.refresh_token);
    expect(stillRevoked.status).toBe(400);
    expect(((await stillRevoked.json()) as { error: string }).error).toBe('invalid_grant');

    const fresh = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...MOHAMED,
      device: 'MohamedLaptop/1.0',
    });
    expect(fresh.tokens.access_token).toBeTruthy();

    const unsuspendEvent = (await auditEvents()).find(
      (event) => event.kind === 'identity.unsuspended' && event.detail.identityId === mohamedId,
    );
    expect(unsuspendEvent).toBeDefined();
    expect(unsuspendEvent!.actorName).toBe(OWNER.name);
  });

  it('suspending from an Application blocks only that Application and kills the platform Sessions', async () => {
    const beforeZotac = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...MOHAMED,
      device: 'MohamedLaptop/1.0',
    });
    const beforeMobile = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...MOHAMED,
      device: 'MohamedPhone/1.0',
    });

    const suspended = await adminPost(
      `/api/applications/${zotac.id}/enrollments/${mohamedId}/suspend`,
    );
    expect(suspended.status).toBe(200);
    expect(
      ((await suspended.json()) as { enrollment: ApplicationEnrollmentView }).enrollment,
    ).toMatchObject({
      identityId: mohamedId,
      email: MOHAMED.email,
      state: 'active',
      suspended: true,
    });

    // Both views agree: the Enrollment is suspended while the Identity is not.
    const enrollments = await applicationEnrollments(zotac.id);
    expect(enrollments.find((entry) => entry.identityId === mohamedId)?.suspended).toBe(true);
    const detail = await identityDetail(mohamedId);
    expect(detail.state).toBe('active');
    expect(
      detail.enrollments.find((entry) => entry.applicationId === zotac.id)?.suspended,
    ).toBe(true);
    expect(
      detail.enrollments.find((entry) => entry.applicationId === mobile.id)?.suspended,
    ).toBe(false);

    // New authentication through the suspended Application is refused at the gate.
    const refused = await signIn({ application: zotac, redirectUri: ZOTAC_REDIRECT, ...MOHAMED });
    expect(refused.status).toBe(302);
    expect(refused.location).toBeTruthy();
    expect(new URL(refused.location!).searchParams.get('error')).toBe('access_denied');

    // Another Application still authenticates: one Enrollment is not the Identity.
    const allowed = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...MOHAMED,
    });
    expect(allowed.tokens.access_token).toBeTruthy();

    // Silent SSO into the suspended Application is refused even with a live Session.
    const sso = await ssoBegin(zotac, ZOTAC_REDIRECT, allowed.cookie);
    expect(sso.status).toBe(302);
    expect(new URL(sso.headers.get('location')!).searchParams.get('error')).toBe('access_denied');

    // The platform Session died for both Applications: the cascade is session-wide.
    for (const [application, session] of [
      [zotac, beforeZotac],
      [mobile, beforeMobile],
    ] as const) {
      const rotated = await refresh(application, session.tokens.refresh_token);
      expect(rotated.status).toBe(400);
      expect(((await rotated.json()) as { error: string }).error).toBe('invalid_grant');
    }

    // Reversible: unsuspending restores that Application.
    const unsuspended = await adminPost(
      `/api/applications/${zotac.id}/enrollments/${mohamedId}/unsuspend`,
    );
    expect(unsuspended.status).toBe(200);
    expect(
      ((await unsuspended.json()) as { enrollment: ApplicationEnrollmentView }).enrollment.suspended,
    ).toBe(false);
    const restored = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...MOHAMED,
    });
    expect(restored.tokens.access_token).toBeTruthy();

    const events = await auditEvents();
    expect(
      events.find(
        (event) =>
          event.kind === 'enrollment.suspended' &&
          event.detail.identityId === mohamedId &&
          event.detail.applicationId === zotac.id,
      ),
    ).toBeDefined();
    expect(
      events.find(
        (event) =>
          event.kind === 'enrollment.unsuspended' &&
          event.detail.identityId === mohamedId &&
          event.detail.applicationId === zotac.id,
      ),
    ).toBeDefined();
  });

  it('lets an access token minted before an Enrollment suspension die within its short TTL', async () => {
    const session = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...MOHAMED,
    });

    const suspended = await adminPost(
      `/api/applications/${zotac.id}/enrollments/${mohamedId}/suspend`,
    );
    expect(suspended.status).toBe(200);

    // Access tokens are untracked by design: the platform's honest verdict for
    // a bearer credential whose Session just died is "still live until its TTL".
    const immediate = await introspect(zotac, session.tokens.access_token);
    expect(await immediate.json()).toMatchObject({ active: true });

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const afterTtl = await introspect(zotac, session.tokens.access_token);
    expect(await afterTtl.json()).toEqual({ active: false });

    const unsuspended = await adminPost(
      `/api/applications/${zotac.id}/enrollments/${mohamedId}/unsuspend`,
    );
    expect(unsuspended.status).toBe(200);
  });

  it('revoke-all-Sessions evicts every device of an Identity in one action', async () => {
    const laptop = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...OMAR,
      device: 'OmarLaptop/1.0',
    });
    const phone = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...OMAR,
      device: 'OmarPhone/1.0',
    });

    const revoked = await adminPost(`/api/identities/${omarId}/sessions/revoke-all`);
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { revoked: number }).revoked).toBe(2);

    const deadDevices = [
      { application: zotac, redirectUri: ZOTAC_REDIRECT, cookie: laptop.cookie },
      { application: mobile, redirectUri: MOBILE_REDIRECT, cookie: phone.cookie },
    ];
    for (const device of deadDevices) {
      const deadCookie = await ssoBegin(device.application, device.redirectUri, device.cookie);
      expect(deadCookie.status).toBe(200);
      expect((await deadCookie.json()) as Record<string, unknown>).toHaveProperty('request');
    }

    for (const [application, session] of [
      [zotac, laptop],
      [mobile, phone],
    ] as const) {
      const rotated = await refresh(application, session.tokens.refresh_token);
      expect(rotated.status).toBe(400);
      expect(((await rotated.json()) as { error: string }).error).toBe('invalid_grant');
    }

    // The device list is empty but the Identity is not suspended.
    const detail = await identityDetail(omarId);
    expect(detail.state).toBe('active');
    expect(detail.sessions).toEqual([]);

    const revokeAllEvent = (await auditEvents()).find(
      (event) =>
        event.kind === 'identity.sessions.revoked' && event.detail.identityId === omarId,
    );
    expect(revokeAllEvent).toBeDefined();
    expect(revokeAllEvent!.actorName).toBe(OWNER.name);
    expect(revokeAllEvent!.detail).toMatchObject({ count: 2, reason: 'administrator' });

    // Not suspended: a fresh sign-in works immediately.
    const again = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...OMAR,
    });
    expect(again.tokens.access_token).toBeTruthy();
  });

  it('serves the levers to Administrator sessions only, and 404s unknown targets', async () => {
    const leverPaths = [
      `/api/identities/${omarId}/suspend`,
      `/api/identities/${omarId}/unsuspend`,
      `/api/identities/${omarId}/sessions/revoke-all`,
      `/api/applications/${zotac.id}/enrollments/${omarId}/suspend`,
      `/api/applications/${zotac.id}/enrollments/${omarId}/unsuspend`,
    ];
    for (const path of leverPaths) {
      const anonymous = await instance.request(path, { method: 'POST', redirect: 'manual' });
      expect(anonymous.status, path).toBe(401);
    }

    // Members pull these levers too: suspension is routine state management,
    // not an Owner-only destructive credential action (ADR-0008, ADR-0019).
    expect((await adminPost(`/api/identities/${omarId}/suspend`, memberCookie)).status).toBe(200);
    expect((await adminPost(`/api/identities/${omarId}/unsuspend`, memberCookie)).status).toBe(200);
    expect((await adminPost(`/api/identities/${omarId}/sessions/revoke-all`, memberCookie)).status).toBe(
      200,
    );

    expect((await adminPost('/api/identities/no-such-identity/suspend')).status).toBe(404);
    expect((await adminPost('/api/identities/no-such-identity/unsuspend')).status).toBe(404);
    expect((await adminPost('/api/identities/no-such-identity/sessions/revoke-all')).status).toBe(404);
    expect(
      (await adminPost(`/api/applications/no-such-application/enrollments/${omarId}/suspend`)).status,
    ).toBe(404);
    expect(
      (await adminPost(`/api/applications/${zotac.id}/enrollments/no-such-identity/suspend`)).status,
    ).toBe(404);
  });
});
