import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 14 — Password change and Administrator force reset with their
 * Session cascades (ADR-0008, ADR-0013). Observed only through Seam 1 (HTTP)
 * and Seam 2 (captured email): the Account Center's self-service password
 * change keeps the Session where it happened and kills every other Session
 * (cookie and descendant refresh tokens); the Management API's force reset is
 * a state lever that sends a reset to the Identity's mailbox and revokes every
 * Session, never touching a credential; completion runs through ticket 04's
 * mailbox-proof flow. No test inspects the database or token internals.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'member password 123', name: 'Layla' };
const MOHAMED = { email: 'mohamed@example.com', password: 'end user password 123' };
const MOHAMED_CHANGED = 'mohamed changed password 456';
const OMAR = { email: 'omar@example.com', password: 'other user password 123' };
const OMAR_CHANGED = 'omar changed password 456';
const OMAR_SECOND = 'omar second password 789';
const UNVERIFIED = { email: 'newcomer@example.com', password: 'unverified user password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const MOBILE_REDIRECT = 'https://mobile.example.com/callback';

const DEVICE_LAPTOP = 'MohamedLaptop/1.0 (Windows NT 10.0)';
const DEVICE_PHONE = 'MohamedPhone/1.0 (Android 15)';
const DEVICE_NEW = 'MohamedTablet/1.0 (iPadOS 18)';

interface ApplicationView {
  id: string;
  clientId: string;
}

interface IdentityListItem {
  id: string;
  email: string;
  state: string;
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
}

interface AccountCenterView {
  currentSessionId: string;
  sessions: Array<{ id: string; device: string | null; current: boolean }>;
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

describe('Password change and Administrator force reset', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let zotac: { id: string; clientId: string; secret: string };
  let mobile: ApplicationView;
  let mohamedId: string;
  let omarId: string;
  let unverifiedId: string;

  let laptopCookie: string;
  let laptopRefresh: string;
  let phoneCookie: string;
  let phoneRefresh: string;
  let phoneSessionId: string;

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
    application: { clientId: string };
    redirectUri: string;
    email: string;
    password: string;
    device: string;
    cookie?: string;
    codeChallenge?: string;
  }): Promise<{ status: number; location: string | null; cookie: string }> => {
    const challenge = options.codeChallenge ?? pkce().challenge;
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
        'user-agent': options.device,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
    return {
      status: res.status,
      location: res.headers.get('location'),
      cookie: cookieFrom(res),
    };
  };

  const exchangeForm = (form: Record<string, string>): Promise<Response> =>
    instance.request('/api/oidc/token', {
      method: 'POST',
      form,
      redirect: 'manual',
    });

  /** Sign in a fresh device and exchange its code for tokens. */
  const signInAndExchange = async (options: {
    application: { id: string; clientId: string; secret?: string };
    redirectUri: string;
    email: string;
    password: string;
    device: string;
  }): Promise<{ cookie: string; tokens: TokenResponse }> => {
    const { verifier, challenge } = pkce();
    const signedIn = await signIn({ ...options, codeChallenge: challenge });
    expect(signedIn.status).toBe(302);
    const code = new URL(signedIn.location!).searchParams.get('code');
    if (!code) throw new Error('no authorization code in redirect');
    const exchanged = await exchangeForm({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      client_id: options.application.clientId,
      ...(options.application.secret ? { client_secret: options.application.secret } : {}),
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    return { cookie: signedIn.cookie, tokens: (await exchanged.json()) as TokenResponse };
  };

  const refresh = (
    refreshToken: string,
    client: { clientId: string; secret?: string },
  ): Promise<Response> =>
    exchangeForm({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      ...(client.secret ? { client_secret: client.secret } : {}),
    });

  const accountCenter = (cookie: string): Promise<Response> =>
    instance.request('/api/account-center', {
      headers: { cookie },
      redirect: 'manual',
    });

  const accountCenterView = async (cookie: string): Promise<AccountCenterView> => {
    const res = await accountCenter(cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as AccountCenterView;
  };

  const changePassword = (
    cookie: string | undefined,
    body: Record<string, string>,
  ): Promise<Response> =>
    instance.request('/api/account-center/password', {
      method: 'POST',
      headers: cookie ? { cookie } : undefined,
      body,
      redirect: 'manual',
    });

  const forceReset = (identityId: string, cookie: string): Promise<Response> =>
    instance.request(`/api/identities/${identityId}/force-password-reset`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });

  const identityIdFor = async (email: string): Promise<string> => {
    const res = await instance.request('/api/identities', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const identities = ((await res.json()) as { identities: IdentityListItem[] }).identities;
    const identity = identities.find((entry) => entry.email === email);
    if (!identity) throw new Error(`no identity for ${email}`);
    return identity.id;
  };

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

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

    await instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { email: MEMBER.email, role: 'member' },
    });
    const invitation = (await instance.capturedEmails()).find(
      (mail) => mail.to === MEMBER.email && /invit/i.test(mail.subject),
    );
    if (!invitation) throw new Error('no invitation mail for the Member');
    const accepted = await instance.request('/api/administrators/invitations/accept', {
      method: 'POST',
      body: { token: tokenFromLink(linkFromBody(invitation.body)), ...MEMBER },
    });
    expect(accepted.status).toBe(201);
    const memberSignIn = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: MEMBER.email, password: MEMBER.password },
    });
    expect(memberSignIn.status).toBe(200);
    memberCookie = cookieFrom(memberSignIn);

    zotac = await registerApplication('Zotac', 'web', ZOTAC_REDIRECT);
    mobile = await registerApplication('Mobile', 'spa', MOBILE_REDIRECT);

    await signUpAndVerify(MOHAMED);
    await signUpAndVerify(OMAR);
    // An inert Unverified Reservation: email claimed, mailbox unproven.
    const unverifiedSignUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: UNVERIFIED,
    });
    expect(unverifiedSignUp.status).toBe(201);
    mohamedId = await identityIdFor(MOHAMED.email);
    omarId = await identityIdFor(OMAR.email);
    unverifiedId = await identityIdFor(UNVERIFIED.email);

    // Mohamed on two devices: the laptop through the confidential client, the
    // phone through the public client. Both lineages are children of their
    // own Session (ADR-0013).
    const laptop = await signInAndExchange({
      application: zotac,
      redirectUri: ZOTAC_REDIRECT,
      ...MOHAMED,
      device: DEVICE_LAPTOP,
    });
    laptopCookie = laptop.cookie;
    laptopRefresh = laptop.tokens.refresh_token;

    const phone = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...MOHAMED,
      device: DEVICE_PHONE,
    });
    phoneCookie = phone.cookie;
    phoneRefresh = phone.tokens.refresh_token;

    const view = await accountCenterView(laptopCookie);
    phoneSessionId = view.sessions.find((session) => session.device === DEVICE_PHONE)!.id;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('refuses an unauthenticated visitor and a wrong current password', async () => {
    const anonymous = await changePassword(undefined, {
      currentPassword: MOHAMED.password,
      newPassword: MOHAMED_CHANGED,
    });
    expect(anonymous.status).toBe(401);

    const garbage = await changePassword('identik_sso_session=not-a-real-token', {
      currentPassword: MOHAMED.password,
      newPassword: MOHAMED_CHANGED,
    });
    expect(garbage.status).toBe(401);

    const wrongCurrent = await changePassword(laptopCookie, {
      currentPassword: 'the wrong password',
      newPassword: MOHAMED_CHANGED,
    });
    expect(wrongCurrent.status).toBe(403);

    const missingPassword = await changePassword(laptopCookie, {
      currentPassword: MOHAMED.password,
    });
    expect(missingPassword.status).toBe(400);

    const shortPassword = await changePassword(laptopCookie, {
      currentPassword: MOHAMED.password,
      newPassword: 'short',
    });
    expect(shortPassword.status).toBe(400);

    // A wrong credential presented by a live Session is audited even though
    // nothing changed — it is what a stolen device looks like.
    const failure = (await auditEvents()).find(
      (event) =>
        event.kind === 'identity.password_change.failed' &&
        event.detail.identityId === mohamedId,
    );
    expect(failure).toBeDefined();
    expect(failure!.actor).toBe('end-user');
    expect(failure!.detail).toMatchObject({
      email: MOHAMED.email,
      reason: 'invalid_current_password',
    });

    // Nothing changed: both devices still resolve, so the failed attempts
    // neither revoked the caller's device nor the others.
    await accountCenterView(laptopCookie);
    await accountCenterView(phoneCookie);
  });

  it('changes the password, keeps the current Session, and revokes every other Session', async () => {
    const changed = await changePassword(laptopCookie, {
      currentPassword: MOHAMED.password,
      newPassword: MOHAMED_CHANGED,
    });
    expect(changed.status).toBe(200);

    // The Session where the change happened stays signed in...
    const laptopView = await accountCenterView(laptopCookie);
    expect(laptopView.sessions.map((session) => session.id)).toContain(laptopView.currentSessionId);
    expect(laptopView.sessions.some((session) => session.id === phoneSessionId)).toBe(false);

    // ...and its refresh lineage survives.
    const survivingRefresh = await refresh(laptopRefresh, {
      clientId: zotac.clientId,
      secret: zotac.secret,
    });
    expect(survivingRefresh.status).toBe(200);

    // Every other device is dead: cookie and descendant refresh tokens.
    const deadCookie = await accountCenter(phoneCookie);
    expect(deadCookie.status).toBe(401);
    const deadRefresh = await refresh(phoneRefresh, { clientId: mobile.clientId });
    expect(deadRefresh.status).toBe(400);
    expect(((await deadRefresh.json()) as { error: string }).error).toBe('invalid_grant');

    // The old credential is gone and the new one works.
    const refused = await signIn({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...MOHAMED,
      device: DEVICE_NEW,
    });
    expect(refused.status).toBe(401);
    const accepted = await signIn({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      email: MOHAMED.email,
      password: MOHAMED_CHANGED,
      device: DEVICE_NEW,
    });
    expect(accepted.status).toBe(302);
    expect(new URL(accepted.location!).searchParams.get('code')).toBeTruthy();

    // The change and its cascade are audit events.
    const events = await auditEvents();
    const passwordChanged = events.find(
      (event) =>
        event.kind === 'identity.password_change.completed' &&
        event.detail.identityId === mohamedId,
    );
    expect(passwordChanged).toBeDefined();
    expect(passwordChanged!.actor).toBe('end-user');
    expect(passwordChanged!.detail).toMatchObject({ email: MOHAMED.email });

    const phoneDeath = events.find(
      (event) =>
        event.kind === 'session.revoked' &&
        event.detail.sessionId === phoneSessionId &&
        event.detail.identityId === mohamedId,
    );
    expect(phoneDeath).toBeDefined();
    expect(phoneDeath!.detail.reason).toBe('password_change');

    const cascade = events.find(
      (event) =>
        event.kind === 'identity.sessions.revoked' &&
        event.detail.identityId === mohamedId &&
        event.detail.reason === 'password_change',
    );
    expect(cascade).toBeDefined();
    expect(cascade!.detail.count).toBe(1);
  });

  it('Administrator force reset delivers to the mailbox and revokes every Session', async () => {
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

    const forced = await forceReset(omarId, ownerCookie);
    expect(forced.status).toBe(200);
    // A state lever, never a credential surface: the response carries an
    // outcome word and nothing else.
    expect(await forced.json()).toEqual({ status: 'reset-sent' });

    // The lever never sets a credential: the old password still
    // authenticates, and that new Session is the window the completion
    // cascade has to catch.
    const windowSession = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...OMAR,
      device: 'OmarTablet/1.0',
    });

    // The reset lands in the Identity's existing mailbox.
    const mail = (await instance.capturedEmails())
      .filter((entry) => entry.to === OMAR.email && /reset/i.test(entry.subject))
      .at(-1);
    if (!mail) throw new Error('no reset mail for Omar');
    const token = tokenFromLink(linkFromBody(mail.body));
    const page = await instance.request('/api/end-users/reset-password', { query: { token } });
    expect(page.status).toBe(200);
    expect((await page.json()) as { valid: boolean }).toMatchObject({ valid: true });

    // Every device that existed when the lever was pulled is dead now:
    // cookie and descendant refresh tokens alike.
    for (const session of [laptop, phone]) {
      const deadCookie = await accountCenter(session.cookie);
      expect(deadCookie.status).toBe(401);
    }
    const deadLaptop = await refresh(laptop.tokens.refresh_token, {
      clientId: zotac.clientId,
      secret: zotac.secret,
    });
    expect(deadLaptop.status).toBe(400);
    expect(((await deadLaptop.json()) as { error: string }).error).toBe('invalid_grant');
    const deadPhone = await refresh(phone.tokens.refresh_token, { clientId: mobile.clientId });
    expect(deadPhone.status).toBe(400);
    expect(((await deadPhone.json()) as { error: string }).error).toBe('invalid_grant');

    const events = await auditEvents();
    const forcedEvent = events.find(
      (event) =>
        event.kind === 'identity.password_reset.forced' && event.detail.identityId === omarId,
    );
    expect(forcedEvent).toBeDefined();
    expect(forcedEvent!.actorName).toBe(OWNER.name);
    expect(forcedEvent!.detail).toMatchObject({ email: OMAR.email });

    const leverCascade = events.find(
      (event) =>
        event.kind === 'identity.sessions.revoked' &&
        event.detail.identityId === omarId &&
        event.detail.reason === 'password_reset',
    );
    expect(leverCascade).toBeDefined();
    expect(leverCascade!.detail.count).toBe(2);

    // Completing the reset is mailbox proof: the new credential is set and
    // every Session dies again — including the one created after the lever.
    const completed = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token, password: OMAR_CHANGED },
    });
    expect(completed.status).toBe(200);

    expect((await accountCenter(windowSession.cookie)).status).toBe(401);
    const deadWindow = await refresh(windowSession.tokens.refresh_token, {
      clientId: mobile.clientId,
    });
    expect(deadWindow.status).toBe(400);
    expect(((await deadWindow.json()) as { error: string }).error).toBe('invalid_grant');

    const refused = await signIn({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      ...OMAR,
      device: 'OmarFresh/1.0',
    });
    expect(refused.status).toBe(401);
    const accepted = await signIn({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      email: OMAR.email,
      password: OMAR_CHANGED,
      device: 'OmarFresh/1.0',
    });
    expect(accepted.status).toBe(302);

    const completedEvent = (await auditEvents()).find(
      (event) =>
        event.kind === 'identity.password_reset.completed' &&
        event.detail.identityId === omarId,
    );
    expect(completedEvent).toBeDefined();
  });

  it('a suspended Identity receives the forced reset but it does not restore access', async () => {
    const beforeSuspension = await signInAndExchange({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      email: OMAR.email,
      password: OMAR_CHANGED,
      device: 'OmarBeforeSuspension/1.0',
    });

    const suspended = await instance.request(`/api/identities/${omarId}/suspend`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(suspended.status).toBe(200);
    expect((await accountCenter(beforeSuspension.cookie)).status).toBe(401);

    const forced = await forceReset(omarId, ownerCookie);
    expect(forced.status).toBe(200);

    const mail = (await instance.capturedEmails())
      .filter((entry) => entry.to === OMAR.email && /reset/i.test(entry.subject))
      .at(-1);
    if (!mail) throw new Error('no reset mail for the suspended Omar');
    const token = tokenFromLink(linkFromBody(mail.body));
    const completed = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token, password: OMAR_SECOND },
    });
    expect(completed.status).toBe(200);

    // The reset set a credential, never access: the suspension gate still
    // refuses authentication uniformly.
    const refused = await signIn({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      email: OMAR.email,
      password: OMAR_SECOND,
      device: 'OmarAfterReset/1.0',
    });
    expect(refused.status).toBe(401);

    // Unsuspending restores authentication — with the password chosen through
    // the mailbox, proving the delivered reset really landed.
    const unsuspended = await instance.request(`/api/identities/${omarId}/unsuspend`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(unsuspended.status).toBe(200);
    const accepted = await signIn({
      application: mobile,
      redirectUri: MOBILE_REDIRECT,
      email: OMAR.email,
      password: OMAR_SECOND,
      device: 'OmarAfterReset/1.0',
    });
    expect(accepted.status).toBe(302);
  });

  it('serves the force reset to Administrator sessions only, Members included', async () => {
    const anonymous = await instance.request(`/api/identities/${omarId}/force-password-reset`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(anonymous.status).toBe(401);

    // An End-User Session is not an Administrator session: separate
    // populations, separate sign-in, separate session types (ADR-0002).
    const endUserCall = await instance.request(
      `/api/identities/${omarId}/force-password-reset`,
      {
        method: 'POST',
        headers: { cookie: laptopCookie },
        redirect: 'manual',
      },
    );
    expect(endUserCall.status).toBe(401);

    // Force reset is routine state management: Members pull it, like
    // suspension (ADR-0008).
    const member = await forceReset(omarId, memberCookie);
    expect(member.status).toBe(200);
    const memberEvent = (await auditEvents()).find(
      (event) =>
        event.kind === 'identity.password_reset.forced' &&
        event.detail.identityId === omarId &&
        event.actorName === MEMBER.name,
    );
    expect(memberEvent).toBeDefined();

    const unknown = await forceReset('no-such-identity', ownerCookie);
    expect(unknown.status).toBe(404);
  });

  it('refuses to force a reset when the Identity has no verified email', async () => {
    // The lever's premise is a proven mailbox. An Unverified Reservation has
    // no verified email to deliver to, and it heals through the mailbox-proof
    // flows, not through an Administrator action (ADR-0011).
    const refused = await forceReset(unverifiedId, ownerCookie);
    expect(refused.status).toBe(409);

    const mail = (await instance.capturedEmails()).filter(
      (entry) => entry.to === UNVERIFIED.email && /reset/i.test(entry.subject),
    );
    expect(mail).toEqual([]);
  });
});
