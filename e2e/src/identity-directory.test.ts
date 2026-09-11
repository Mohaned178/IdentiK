import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 12 — Dashboard Identity and Enrollment views (ADR-0008, ADR-0019).
 * Observed only through Seam 1 (the Management API over HTTP, plus captured
 * email for the setup the views inspect).
 *
 * The Identity list shows every Identity of the Organization with its
 * authentication state; the Identity detail shows email, verification state,
 * Enrollments, active Sessions, and recent authentication activity — and
 * nothing that authenticates. The per-Application view is the Enrollment list
 * filtered to that Application. Members can look; anonymous callers cannot;
 * and there is no route anywhere that sets a credential.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'member password 123', name: 'Layla' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const OTHER_USER = { email: 'omar@example.com', password: 'other user password 123' };
const UNVERIFIED = { email: 'newcomer@example.com', password: 'unverified password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const MOBILE_REDIRECT = 'https://mobile.example.com/callback';

interface IdentityListItem {
  id: string;
  email: string;
  emailVerified: boolean;
  state: string;
  createdAt: string;
}

interface EnrollmentView {
  applicationId: string;
  applicationName: string;
  applicationType: string;
  enrolledAt: string;
  suspended: boolean;
}

interface SessionView {
  id: string;
  device: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface ActivityView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface IdentityDetail extends IdentityListItem {
  enrollments: EnrollmentView[];
  sessions: SessionView[];
  recentActivity: ActivityView[];
}

interface ApplicationEnrollmentView {
  identityId: string;
  email: string;
  emailVerified: boolean;
  state: string;
  enrolledAt: string;
  suspended: boolean;
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

/** Every object key in a JSON value, recursively — for credential audits. */
function keyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keyNames);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keyNames(child)]);
  }
  return [];
}

describe('Dashboard Identity and Enrollment views', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let zotac: { id: string; clientId: string };
  let mobile: { id: string; clientId: string };

  const listIdentities = (cookie?: string): Promise<Response> =>
    instance.request('/api/identities', {
      headers: cookie ? { cookie } : undefined,
      redirect: 'manual',
    });

  const identitiesFor = async (cookie: string): Promise<IdentityListItem[]> => {
    const res = await listIdentities(cookie);
    expect(res.status).toBe(200);
    return ((await res.json()) as { identities: IdentityListItem[] }).identities;
  };

  const identityDetail = async (
    cookie: string,
    identityId: string,
  ): Promise<IdentityDetail> => {
    const res = await instance.request(`/api/identities/${identityId}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { identity: IdentityDetail }).identity;
  };

  const applicationEnrollments = async (
    cookie: string,
    applicationId: string,
  ): Promise<ApplicationEnrollmentView[]> => {
    const res = await instance.request(`/api/applications/${applicationId}/enrollments`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { enrollments: ApplicationEnrollmentView[] }).enrollments;
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
    const application = ((await registered.json()) as {
      application: { id: string; clientId: string };
    }).application;
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

  const signIn = async (options: {
    clientId: string;
    redirectUri: string;
    email: string;
    password: string;
    device: string;
    codeChallenge?: string;
  }): Promise<number> => {
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
    return res.status;
  };

  const pkceChallenge = (): string =>
    createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

  let endUserId: string;
  let otherUserId: string;
  let unverifiedId: string;

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

    // A Member: viewing is day-to-day administration, not an Owner lever.
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

    await signUp(END_USER);
    await verify(END_USER.email);
    await signUp(OTHER_USER);
    await verify(OTHER_USER.email);
    await signUp(UNVERIFIED);

    // Authentication activity the detail view must surface.
    expect(
      await signIn({
        clientId: zotac.clientId,
        redirectUri: ZOTAC_REDIRECT,
        email: END_USER.email,
        password: 'the wrong password',
        device: 'ZotacBrowser/1.0',
      }),
    ).toBe(401);

    expect(
      await signIn({
        clientId: zotac.clientId,
        redirectUri: ZOTAC_REDIRECT,
        email: END_USER.email,
        password: END_USER.password,
        device: 'ZotacBrowser/1.0',
      }),
    ).toBe(302);
    expect(
      await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        email: END_USER.email,
        password: END_USER.password,
        device: 'MobileDevice/7',
        codeChallenge: pkceChallenge(),
      }),
    ).toBe(302);
    expect(
      await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        email: OTHER_USER.email,
        password: OTHER_USER.password,
        device: 'OmarLaptop/2.0',
        codeChallenge: pkceChallenge(),
      }),
    ).toBe(302);

    const listed = await identitiesFor(ownerCookie);
    endUserId = listed.find((identity) => identity.email === END_USER.email)!.id;
    otherUserId = listed.find((identity) => identity.email === OTHER_USER.email)!.id;
    unverifiedId = listed.find((identity) => identity.email === UNVERIFIED.email)!.id;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('lists every Identity of the Organization with its authentication state', async () => {
    const identities = await identitiesFor(ownerCookie);
    expect(identities).toHaveLength(3);

    for (const identity of identities) {
      expect(identity.id).toBeTruthy();
      expect(Number.isNaN(Date.parse(identity.createdAt))).toBe(false);
      expect(typeof identity.emailVerified).toBe('boolean');
      expect(['active', 'unverified', 'suspended']).toContain(identity.state);
    }

    expect(identities.find((identity) => identity.id === endUserId)).toMatchObject({
      email: END_USER.email,
      emailVerified: true,
      state: 'active',
    });
    expect(identities.find((identity) => identity.id === otherUserId)).toMatchObject({
      email: OTHER_USER.email,
      emailVerified: true,
      state: 'active',
    });
    expect(identities.find((identity) => identity.id === unverifiedId)).toMatchObject({
      email: UNVERIFIED.email,
      emailVerified: false,
      state: 'unverified',
    });
  });

  it('carries no credential material on the list or the detail', async () => {
    const identities = await identitiesFor(ownerCookie);
    const detail = await identityDetail(ownerCookie, endUserId);

    const forbiddenKeys = [
      'password',
      'passwordhash',
      'password_hash',
      'tokenhash',
      'token_hash',
      'ssotokenhash',
      'sso_token_hash',
      'secret',
    ];
    for (const view of [identities, detail]) {
      for (const key of keyNames(view).map((name) => name.toLowerCase())) {
        expect(forbiddenKeys, key).not.toContain(key);
      }
      expect(JSON.stringify(view)).not.toContain(END_USER.password);
    }
  });

  it('shows Enrollments, active Sessions, and recent authentication activity on the detail', async () => {
    const detail = await identityDetail(ownerCookie, endUserId);
    expect(detail).toMatchObject({
      email: END_USER.email,
      emailVerified: true,
      state: 'active',
    });

    expect(detail.enrollments).toHaveLength(2);
    expect(detail.enrollments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          applicationId: zotac.id,
          applicationName: 'Zotac',
          applicationType: 'web',
          suspended: false,
        }),
        expect.objectContaining({
          applicationId: mobile.id,
          applicationName: 'Mobile',
          applicationType: 'spa',
          suspended: false,
        }),
      ]),
    );

    expect(detail.sessions).toHaveLength(2);
    const devices = detail.sessions.map((session) => session.device);
    expect(devices).toContain('ZotacBrowser/1.0');
    expect(devices).toContain('MobileDevice/7');
    for (const session of detail.sessions) {
      expect(Number.isNaN(Date.parse(session.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(session.lastSeenAt))).toBe(false);
    }

    const kinds = detail.recentActivity.map((event) => event.kind);
    expect(kinds).toContain('identity.verification.completed');
    expect(kinds).toContain('identity.sign_in.failed');
    expect(kinds).toContain('enrollment.created');
    // Only this Identity's events: the durable link is the detail's identityId.
    expect(
      detail.recentActivity.every((event) => event.detail.identityId === endUserId),
    ).toBe(true);
    const times = detail.recentActivity.map((event) => Date.parse(event.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // The other Identity's activity stays out of this page.
    const other = await identityDetail(ownerCookie, otherUserId);
    expect(
      other.recentActivity.some((event) => event.detail.identityId === endUserId),
    ).toBe(false);
    expect(other.sessions).toHaveLength(1);
    expect(other.sessions[0]!.device).toBe('OmarLaptop/2.0');
  });

  it('flags an unverified reservation as inert with no Enrollments or Sessions', async () => {
    const identities = await identitiesFor(ownerCookie);
    const reservation = identities.find((identity) => identity.id === unverifiedId)!;
    expect(reservation.state).toBe('unverified');
    expect(reservation.emailVerified).toBe(false);

    const detail = await identityDetail(ownerCookie, unverifiedId);
    expect(detail.enrollments).toEqual([]);
    expect(detail.sessions).toEqual([]);
  });

  it('lists Enrollments filtered to one Application', async () => {
    const zotacEnrollments = await applicationEnrollments(ownerCookie, zotac.id);
    expect(zotacEnrollments).toHaveLength(1);
    expect(zotacEnrollments[0]).toMatchObject({
      identityId: endUserId,
      email: END_USER.email,
      emailVerified: true,
      state: 'active',
      suspended: false,
    });
    expect(zotacEnrollments.some((entry) => entry.email === UNVERIFIED.email)).toBe(false);

    const mobileEnrollments = await applicationEnrollments(ownerCookie, mobile.id);
    expect(mobileEnrollments.map((entry) => entry.identityId).sort()).toEqual(
      [endUserId, otherUserId].sort(),
    );
    expect(mobileEnrollments.some((entry) => entry.email === UNVERIFIED.email)).toBe(false);

    const unknown = await instance.request(
      '/api/applications/no-such-application/enrollments',
      { headers: { cookie: ownerCookie } },
    );
    expect(unknown.status).toBe(404);
  });

  it('serves the views to Administrator sessions only, Member included', async () => {
    for (const path of [
      '/api/identities',
      `/api/identities/${endUserId}`,
      `/api/applications/${zotac.id}/enrollments`,
    ]) {
      const anonymous = await instance.request(path);
      expect(anonymous.status, path).toBe(401);
    }

    const list = await listIdentities(memberCookie);
    expect(list.status).toBe(200);
    const detail = await instance.request(`/api/identities/${endUserId}`, {
      headers: { cookie: memberCookie },
    });
    expect(detail.status).toBe(200);
    const enrollments = await instance.request(
      `/api/applications/${zotac.id}/enrollments`,
      { headers: { cookie: memberCookie } },
    );
    expect(enrollments.status).toBe(200);
  });

  it('offers no path that sets a credential', async () => {
    const setPassword = await instance.request(`/api/identities/${endUserId}/password`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { password: 'administrator-chosen' },
    });
    expect(setPassword.status).toBe(404);

    const patch = await instance.request(`/api/identities/${endUserId}`, {
      method: 'PATCH',
      headers: { cookie: ownerCookie },
      body: { email: 'changed@example.com' },
    });
    expect(patch.status).toBe(404);

    const unknown = await instance.request('/api/identities/no-such-identity', {
      headers: { cookie: ownerCookie },
    });
    expect(unknown.status).toBe(404);
  });
});
