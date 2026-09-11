import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 16 — Application disable and delete (ADR-0007, ADR-0009). Observed
 * only through Seam 1 (the Management API, the hosted authorization endpoint,
 * the token endpoint, and introspection) and Seam 2 (captured email).
 *
 * Disable is a reversible pause: new authentication through the Application is
 * refused, every refresh token minted by its flows is revoked, and platform
 * Sessions survive. Delete is Owner-only and irreversible: Enrollments are
 * removed, credentials revoked, audit pseudonymized — while Identities survive,
 * including those orphaned by the deletion (ADR-0004).
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
  name: string;
  clientId: string;
  state: string;
  secrets: Array<{ id: string; label: string; revokedAt: string | null }>;
  redirectUris: Array<{ id: string; uri: string }>;
}

interface AppRef {
  id: string;
  clientId: string;
  secret: string;
  redirectUri: string;
}

interface IdentityListItem {
  id: string;
  email: string;
  state: string;
}

interface EnrollmentView {
  applicationId: string;
  applicationName: string;
}

interface IdentityDetail extends IdentityListItem {
  enrollments: EnrollmentView[];
  sessions: Array<{ id: string; device: string | null }>;
}

interface ApplicationEnrollmentView {
  identityId: string;
  email: string;
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

describe('Application disable and delete', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let zotac: AppRef;
  let mobile: AppRef;
  let mohamedId: string;
  let omarId: string;

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  const adminPost = (path: string, cookie = ownerCookie, body?: unknown): Promise<Response> =>
    instance.request(path, {
      method: 'POST',
      headers: { cookie },
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
    });

  const adminDelete = (path: string, cookie = ownerCookie, body?: unknown): Promise<Response> =>
    instance.request(path, {
      method: 'DELETE',
      headers: { cookie },
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
    });

  const authorizeQuery = (app: AppRef) => ({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: randomBytes(8).toString('base64url'),
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  });

  const signIn = async (options: {
    app: AppRef;
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
        client_id: options.app.clientId,
        redirect_uri: options.app.redirectUri,
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
  const ssoBegin = (app: AppRef, cookie: string): Promise<Response> =>
    instance.request('/api/oidc/authorize', {
      redirect: 'manual',
      query: authorizeQuery(app),
      headers: { cookie },
    });

  const signInAndExchange = async (options: {
    app: AppRef;
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
        redirect_uri: options.app.redirectUri,
        client_id: options.app.clientId,
        code_verifier: result.verifier,
        ...(options.app.secret ? { client_secret: options.app.secret } : {}),
      },
    });
    expect(exchanged.status).toBe(200);
    return { cookie: result.cookie, tokens: (await exchanged.json()) as TokenResponse };
  };

  const refresh = (app: AppRef, refreshToken: string): Promise<Response> =>
    instance.request('/api/oidc/token', {
      method: 'POST',
      redirect: 'manual',
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: app.clientId,
        ...(app.secret ? { client_secret: app.secret } : {}),
      },
    });

  const introspect = (app: AppRef, token: string): Promise<Response> =>
    instance.request('/api/oidc/introspect', {
      method: 'POST',
      redirect: 'manual',
      form: { token, client_id: app.clientId, ...(app.secret ? { client_secret: app.secret } : {}) },
    });

  const errorIn = (location: string | null): string | null =>
    location ? new URL(location).searchParams.get('error') : null;

  const appDetail = async (applicationId: string): Promise<ApplicationView> => {
    const res = await instance.request(`/api/applications/${applicationId}`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { application: ApplicationView }).application;
  };

  const appList = async (): Promise<ApplicationView[]> => {
    const res = await instance.request('/api/applications', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { applications: ApplicationView[] }).applications;
  };

  const applicationEnrollments = async (applicationId: string): Promise<ApplicationEnrollmentView[]> => {
    const res = await instance.request(`/api/applications/${applicationId}/enrollments`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { enrollments: ApplicationEnrollmentView[] }).enrollments;
  };

  const identities = async (): Promise<IdentityListItem[]> => {
    const res = await instance.request('/api/identities', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { identities: IdentityListItem[] }).identities;
  };

  const identityDetail = async (identityId: string): Promise<IdentityDetail> => {
    const res = await instance.request(`/api/identities/${identityId}`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { identity: IdentityDetail }).identity;
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
    type: 'web' | 'spa',
    redirectUri: string,
  ): Promise<AppRef> => {
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
      redirectUri,
    };
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
    instance = await Instance.start(BACKEND_DIST, { IDENTIK_ACCESS_TOKEN_TTL_MS: '60000' });

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

    zotac = await registerApplication('Zotac', 'web', ZOTAC_REDIRECT);
    mobile = await registerApplication('Mobile', 'spa', MOBILE_REDIRECT);

    await signUp(MOHAMED);
    await verify(MOHAMED.email);
    await signUp(OMAR);
    await verify(OMAR.email);

    // Mohamed uses both Applications; Omar uses only Zotac, so he is orphaned
    // when Zotac is deleted.
    await signInAndExchange({ app: zotac, ...MOHAMED, device: 'MohamedLaptop/1.0' });
    await signInAndExchange({ app: mobile, ...MOHAMED, device: 'MohamedPhone/1.0' });
    await signInAndExchange({ app: zotac, ...OMAR, device: 'OmarLaptop/1.0' });

    const listed = await identities();
    mohamedId = listed.find((identity) => identity.email === MOHAMED.email)!.id;
    omarId = listed.find((identity) => identity.email === OMAR.email)!.id;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('disabling pauses one Application, revokes its refresh tokens, and keeps Sessions alive', async () => {
    const mobileSession = await signInAndExchange({ app: mobile, ...MOHAMED });
    const zotacSession = await signInAndExchange({ app: zotac, ...MOHAMED });

    // Members pause Applications: it is routine state management (ADR-0008).
    const disabled = await adminPost(`/api/applications/${mobile.id}/disable`, memberCookie);
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { application: ApplicationView }).application.state).toBe(
      'disabled',
    );

    // New authentication through the paused Application is refused, uniformly
    // for a fresh credential sign-in and a silent SSO.
    const refused = await signIn({ app: mobile, ...MOHAMED });
    expect(refused.status).toBe(302);
    expect(errorIn(refused.location)).toBe('access_denied');

    const refusedSso = await ssoBegin(mobile, mobileSession.cookie);
    expect(refusedSso.status).toBe(302);
    expect(errorIn(refusedSso.headers.get('location'))).toBe('access_denied');

    // The other Application is untouched.
    const otherApp = await signInAndExchange({ app: zotac, ...MOHAMED });
    expect(otherApp.tokens.access_token).toBeTruthy();

    // The pause is not credential revocation: the Session that authenticated
    // through the paused Application is still live and can reach another App.
    const survived = await ssoBegin(zotac, mobileSession.cookie);
    expect(survived.status).toBe(302);
    expect(new URL(survived.headers.get('location')!).searchParams.get('code')).toBeTruthy();

    // Refresh tokens minted by the paused Application's flows are refused...
    const rotated = await refresh(mobile, mobileSession.tokens.refresh_token);
    expect(rotated.status).toBe(400);
    expect(((await rotated.json()) as { error: string }).error).toBe('invalid_grant');
    const verdict = await introspect(mobile, mobileSession.tokens.refresh_token);
    expect(await verdict.json()).toEqual({ active: false });

    const disableEvent = (await auditEvents()).find(
      (event) =>
        event.kind === 'application.disabled' &&
        event.detail.applicationId === mobile.id,
    );
    expect(disableEvent).toBeDefined();
    expect(disableEvent!.actorName).toBe(MEMBER.name);
    expect(disableEvent!.detail).toMatchObject({ name: 'Mobile' });

    // Re-enable restores authentication for non-suspended Identities...
    const enabled = await adminPost(`/api/applications/${mobile.id}/enable`);
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { application: ApplicationView }).application.state).toBe(
      'active',
    );
    const restored = await signInAndExchange({ app: mobile, ...MOHAMED });
    expect(restored.tokens.access_token).toBeTruthy();

    // ...but the revoked refresh tokens stay dead: the pause was permanent for
    // credentials, reversible only for authentication.
    const stillRevoked = await refresh(mobile, mobileSession.tokens.refresh_token);
    expect(stillRevoked.status).toBe(400);
    expect(((await stillRevoked.json()) as { error: string }).error).toBe('invalid_grant');

    // The pre-pause Session survived the whole arc.
    const stillAlive = await ssoBegin(mobile, mobileSession.cookie);
    expect(stillAlive.status).toBe(302);
    expect(new URL(stillAlive.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  it('deleting an Application removes Enrollments, revokes credentials, and leaves Identities orphaned but alive', async () => {
    const beforeDelete = await signInAndExchange({ app: zotac, ...MOHAMED });

    // Deletion is Owner-only and demands a plain irreversibility confirmation.
    expect((await adminDelete(`/api/applications/${zotac.id}`, memberCookie, { confirm: true })).status).toBe(403);

    const unconfirmed = await adminDelete(`/api/applications/${zotac.id}`, ownerCookie, {});
    expect(unconfirmed.status).toBe(400);
    expect(((await unconfirmed.json()) as { message: string }).message).toMatch(/irreversib/i);
    expect((await appDetail(zotac.id)).state).toBe('active');

    const deleted = await adminDelete(`/api/applications/${zotac.id}`, ownerCookie, { confirm: true });
    expect(deleted.status).toBe(200);
    const shell = ((await deleted.json()) as { application: ApplicationView }).application;
    expect(shell.state).toBe('deleted');
    expect(shell.name).not.toBe('Zotac');
    expect(shell.name).toMatch(/deleted application #/i);

    // Credentials are revoked: every Client Secret carries a revocation, and
    // the Client Secret that authenticates Zotac no longer works.
    const detail = await appDetail(zotac.id);
    expect(detail.state).toBe('deleted');
    expect(detail.secrets.length).toBeGreaterThan(0);
    expect(detail.secrets.every((secret) => secret.revokedAt !== null)).toBe(true);

    // Enrollments are gone; new authentication is refused.
    expect(await applicationEnrollments(zotac.id)).toEqual([]);
    const refused = await signIn({ app: zotac, ...MOHAMED });
    expect(refused.status).toBe(302);
    expect(errorIn(refused.location)).toBe('access_denied');

    // The refresh tokens Zotac minted before deletion are dead — its revoked
    // secret or the disabled Application refuses the rotation.
    const deadRefresh = await refresh(zotac, beforeDelete.tokens.refresh_token);
    expect([400, 401]).toContain(deadRefresh.status);

    // Identities survive — including Omar, now with no Enrollments at all.
    const listed = await identities();
    expect(listed.map((identity) => identity.email).sort()).toEqual(
      [MOHAMED.email, OMAR.email].sort(),
    );
    const orphan = await identityDetail(omarId);
    expect(orphan.email).toBe(OMAR.email);
    expect(orphan.enrollments).toEqual([]);
    const mohamed = await identityDetail(mohamedId);
    expect(mohamed.enrollments.map((entry) => entry.applicationId)).toEqual([mobile.id]);

    // The deleted Application's audit trail survives pseudonymously: the
    // registration's name is scrubbed, and the deletion is attributed.
    const events = await auditEvents();
    const registration = events.find(
      (event) => event.kind === 'application.registered' && event.detail.applicationId === zotac.id,
    );
    expect(registration).toBeDefined();
    expect(registration!.detail.name).toMatch(/deleted application #/i);
    const deletion = events.find(
      (event) => event.kind === 'application.deleted' && event.detail.applicationId === zotac.id,
    );
    expect(deletion).toBeDefined();
    expect(deletion!.actorName).toBe(OWNER.name);
    expect(String(deletion!.detail.pseudonym)).toMatch(/deleted application #/i);
    expect(deletion!.detail).not.toHaveProperty('name');

    // The shell remains visible in the directory, pseudonymously.
    const apps = await appList();
    expect(apps.find((app) => app.id === zotac.id)?.state).toBe('deleted');
  });

  it('serves the lifecycle levers to Administrator sessions only, and 404s unknown targets', async () => {
    const anonymousDisable = await instance.request(
      `/api/applications/${mobile.id}/disable`,
      { method: 'POST', redirect: 'manual' },
    );
    expect(anonymousDisable.status).toBe(401);
    const anonymousDelete = await instance.request(`/api/applications/${mobile.id}`, {
      method: 'DELETE',
      body: { confirm: true },
      redirect: 'manual',
    });
    expect(anonymousDelete.status).toBe(401);

    expect((await adminPost('/api/applications/no-such-application/disable')).status).toBe(404);
    expect((await adminPost('/api/applications/no-such-application/enable')).status).toBe(404);
    expect(
      (await adminDelete('/api/applications/no-such-application', ownerCookie, { confirm: true }))
        .status,
    ).toBe(404);

    // A deleted Application is terminal: disable/enable cannot revive it.
    const deletedAgain = await adminDelete(`/api/applications/${zotac.id}`, ownerCookie, {
      confirm: true,
    });
    expect(deletedAgain.status).toBe(200);
    expect(((await deletedAgain.json()) as { application: ApplicationView }).application.state).toBe(
      'deleted',
    );
    expect((await adminPost(`/api/applications/${zotac.id}/enable`)).status).toBe(200);
    expect((await appDetail(zotac.id)).state).toBe('deleted');

    const deletionCount = (await auditEvents()).filter(
      (event) => event.kind === 'application.deleted' && event.detail.applicationId === zotac.id,
    ).length;
    expect(deletionCount).toBe(1);
  });
});
