import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 15 — Identity anonymization, the irreversible sibling of suspension
 * (ADR-0007, ADR-0008, ADR-0013). Observed only through Seam 1 (the Management
 * API, the hosted authorization endpoint, the token endpoint, introspection,
 * and userinfo) and Seam 2 (captured email).
 *
 * Deleting an Identity destroys its email, credentials, Sessions, and
 * Enrollments, while the audit trail survives against a pseudonymous shell so
 * "who signed in from that IP last Tuesday?" stays answerable. The destroyed
 * email is immediately reusable by a fresh, unlinked Identity that inherits
 * nothing, and no path restores the shell.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'member password 123', name: 'Layla' };
const MOHAMED = { email: 'mohamed@example.com', password: 'end user password 123' };
const OMAR = { email: 'omar@example.com', password: 'other user password 123' };
const NEW_PASSWORD = 'reborn password 456';

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const MOBILE_REDIRECT = 'https://mobile.example.com/callback';

interface ApplicationView {
  id: string;
  clientId: string;
}

interface IdentityListItem {
  id: string;
  email: string;
  emailVerified: boolean;
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
  enrollments: EnrollmentView[];
  sessions: SessionView[];
  recentActivity: ActivityView[];
}

interface ApplicationEnrollmentView {
  identityId: string;
  email: string;
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

describe('Identity anonymization', () => {
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

  const adminPost = (
    path: string,
    body: unknown,
    cookie = ownerCookie,
  ): Promise<Response> =>
    instance.request(path, {
      method: 'POST',
      headers: { cookie },
      body,
      redirect: 'manual',
    });

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

  const ssoBegin = (
    application: ApplicationView,
    redirectUri: string,
    cookie: string,
  ): Promise<Response> =>
    instance.request('/api/oidc/authorize', {
      redirect: 'manual',
      query: {
        client_id: application.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: randomBytes(8).toString('base64url'),
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      },
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

  const userinfo = (accessToken: string): Promise<Response> =>
    instance.request('/api/oidc/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
    });

  const identityDetail = async (identityId: string, cookie = ownerCookie): Promise<IdentityDetail> => {
    const res = await instance.request(`/api/identities/${identityId}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { identity: IdentityDetail }).identity;
  };

  const identities = async (): Promise<IdentityListItem[]> => {
    const res = await instance.request('/api/identities', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { identities: IdentityListItem[] }).identities;
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

  /** The Identity detail's audit trail — the intended consumer of the
   * identityId filter (ticket 12 deliberately keeps it off the audit route). */
  const recentActivity = async (identityId: string): Promise<ActivityView[]> =>
    (await identityDetail(identityId)).recentActivity;

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

    zotac = await registerApplication('Zotac', ZOTAC_REDIRECT);
    mobile = await registerApplication('Mobile', MOBILE_REDIRECT);

    await signUp(MOHAMED);
    await verify(MOHAMED.email);
    await signUp(OMAR);
    await verify(OMAR.email);

    const listed = await identities();
    mohamedId = listed.find((identity) => identity.email === MOHAMED.email)!.id;
    omarId = listed.find((identity) => identity.email === OMAR.email)!.id;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('destroys credentials, Sessions, and Enrollments, refusing every authentication path', async () => {
    const session = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...MOHAMED,
      device: 'MohamedLaptop/1.0',
    });

    // A live reset link exists before deletion: it must not survive as a
    // recovery path afterwards.
    await instance.request('/api/end-users/forgot-password', {
      method: 'POST',
      body: { email: MOHAMED.email },
    });
    const resetMail = (await instance.capturedEmails())
      .filter((entry) => entry.to === MOHAMED.email && /reset/i.test(entry.subject))
      .at(-1);
    const staleResetToken = tokenFromLink(linkFromBody(resetMail!.body));

    const before = await identityDetail(mohamedId);
    expect(before).toMatchObject({ email: MOHAMED.email, state: 'active' });
    expect(before.enrollments).toHaveLength(1);
    expect(before.sessions).toHaveLength(1);

    const anonymized = await adminPost(`/api/identities/${mohamedId}/anonymize`, {
      confirm: true,
    });
    expect(anonymized.status).toBe(200);
    const shell = ((await anonymized.json()) as { identity: IdentityDetail }).identity;
    expect(shell.state).toBe('anonymized');
    expect(shell.emailVerified).toBe(false);
    expect(shell.email).not.toBe(MOHAMED.email);
    expect(shell.email).toMatch(/deleted identity #/i);
    expect(shell.enrollments).toEqual([]);
    expect(shell.sessions).toEqual([]);

    // The credential no longer exists: the old password is refused.
    const refused = await signIn({ application: zotac, redirectUri: ZOTAC_REDIRECT, ...MOHAMED });
    expect(refused.status).toBe(401);

    // The Session lineage is dead: cookie, refresh rotation, introspection.
    const deadCookie = await ssoBegin(zotac, ZOTAC_REDIRECT, session.cookie);
    expect(deadCookie.status).toBe(200);
    expect((await deadCookie.json()) as Record<string, unknown>).toHaveProperty('request');

    const rotated = await refresh(zotac, session.tokens.refresh_token);
    expect(rotated.status).toBe(400);
    expect(((await rotated.json()) as { error: string }).error).toBe('invalid_grant');

    const accessVerdict = await introspect(zotac, session.tokens.access_token);
    expect(await accessVerdict.json()).toEqual({ active: false });
    const refusedUserinfo = await userinfo(session.tokens.access_token);
    expect(refusedUserinfo.status).toBe(401);

    // Enrollments are gone from the Application's people.
    const enrollments = await applicationEnrollments(zotac.id);
    expect(enrollments.some((entry) => entry.identityId === mohamedId)).toBe(false);

    // The pre-deletion reset link is dead.
    const staleReset = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token: staleResetToken, password: NEW_PASSWORD },
    });
    expect(staleReset.status).toBe(400);

    // The audit trail survives, attributed to the shell, not the destroyed email.
    const trail = await recentActivity(mohamedId);
    expect(trail.length).toBeGreaterThanOrEqual(3);
    expect(trail.some((event) => event.kind === 'identity.anonymized')).toBe(true);
    expect(trail.some((event) => event.kind === 'identity.verification.completed')).toBe(true);
    for (const event of trail) {
      expect(JSON.stringify(event.detail)).not.toContain(MOHAMED.email);
    }
    const anonymizationEvent = trail.find((event) => event.kind === 'identity.anonymized')!;
    expect(anonymizationEvent.actorName).toBe(OWNER.name);
    expect(anonymizationEvent.detail).toMatchObject({ identityId: mohamedId });
    expect(String(anonymizationEvent.detail.pseudonym)).toMatch(/deleted identity #/i);
    expect(anonymizationEvent.detail).not.toHaveProperty('email');
  });

  it('frees the email for a fresh Identity that inherits no sessions, enrollments, or history', async () => {
    await signUp(MOHAMED);
    await verify(MOHAMED.email);

    const listed = await identities();
    const reborn = listed.find((identity) => identity.email === MOHAMED.email);
    expect(reborn).toBeDefined();
    expect(reborn!.id).not.toBe(mohamedId);
    const rebornId = reborn!.id;

    const fresh = await identityDetail(rebornId);
    expect(fresh).toMatchObject({ email: MOHAMED.email, state: 'active' });
    expect(fresh.enrollments).toEqual([]);
    expect(fresh.sessions).toEqual([]);

    // The new trail starts clean: nothing in it points at the old Identity.
    expect(fresh.recentActivity.length).toBeGreaterThan(0);
    for (const event of fresh.recentActivity) {
      expect(event.detail.identityId).not.toBe(mohamedId);
    }
    const newTrail = await recentActivity(rebornId);
    expect(newTrail.some((event) => event.kind === 'identity.verification.completed')).toBe(true);
    expect(newTrail.every((event) => event.detail.identityId !== mohamedId)).toBe(true);

    // The reused email authenticates as the new, unlinked Identity.
    const authenticated = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...MOHAMED,
      device: 'MohamedNewPhone/2.0',
    });
    expect(authenticated.tokens.access_token).toBeTruthy();
    const updated = await identityDetail(rebornId);
    expect(updated.enrollments).toHaveLength(1);
    expect(updated.sessions).toHaveLength(1);

    // The old shell still owns its own, pseudonymous trail — and nothing else.
    const oldTrail = await recentActivity(mohamedId);
    expect(oldTrail.every((event) => event.detail.identityId !== rebornId)).toBe(true);
    for (const event of oldTrail) {
      expect(JSON.stringify(event.detail)).not.toContain(MOHAMED.email);
    }
  });

  it('is irreversible: no lever restores the shell', async () => {
    const unsuspend = await adminPost(`/api/identities/${mohamedId}/unsuspend`, {});
    expect(unsuspend.status).toBe(200);
    expect(
      ((await unsuspend.json()) as { identity: IdentityDetail }).identity.state,
    ).toBe('anonymized');

    const forceReset = await adminPost(`/api/identities/${mohamedId}/force-password-reset`, {});
    expect(forceReset.status).toBe(409);

    // The shell's stored handle is not a reachable mailbox: recovery on it is
    // refused as malformed, never a resurrection.
    const shell = await identityDetail(mohamedId);
    const forgot = await instance.request('/api/end-users/forgot-password', {
      method: 'POST',
      body: { email: shell.email },
    });
    expect(forgot.status).toBe(400);
    const stillShell = await identityDetail(mohamedId);
    expect(stillShell.state).toBe('anonymized');
    expect(stillShell.emailVerified).toBe(false);
  });

  it('requires a plain irreversibility confirmation and serves Administrator sessions only', async () => {
    const anonymous = await instance.request(`/api/identities/${omarId}/anonymize`, {
      method: 'POST',
      body: { confirm: true },
      redirect: 'manual',
    });
    expect(anonymous.status).toBe(401);

    const unconfirmed = await adminPost(`/api/identities/${omarId}/anonymize`, {});
    expect(unconfirmed.status).toBe(400);
    expect(((await unconfirmed.json()) as { message: string }).message).toMatch(/irreversib/i);
    const untouched = await identityDetail(omarId);
    expect(untouched.state).toBe('active');

    // Members pull the lever too: anonymization is routine state management
    // (ADR-0008), unlike Application deletion which ticket 16 reserves to Owners.
    const byMember = await adminPost(
      `/api/identities/${omarId}/anonymize`,
      { confirm: true },
      memberCookie,
    );
    expect(byMember.status).toBe(200);
    expect(
      ((await byMember.json()) as { identity: IdentityDetail }).identity.state,
    ).toBe('anonymized');

    const unknown = await adminPost('/api/identities/no-such-identity/anonymize', {
      confirm: true,
    });
    expect(unknown.status).toBe(404);
  });
});
