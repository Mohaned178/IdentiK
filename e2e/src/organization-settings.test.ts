import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 18 — Organization settings: branding, password policy, session
 * timeout (ADR-0022). The Organization-scoped half of the settings boundary is
 * dashboard-governed through the Management API and audit-logged, while the
 * instance-scoped trust fabric (SMTP, signing keys) is structurally
 * unreachable from the API. Everything is observed over Seam 1 (HTTP) only:
 * an Owner edits, a Member reads, the hosted pages and Account Center render
 * the branding, weak passwords are refused at the credential gates, and idle
 * Sessions lapse after the configured window while activity refreshes it.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'member password 123', name: 'Layla' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const REDIRECT = 'https://mobile.example.com/callback';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface Branding {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
}

interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

interface SessionPolicy {
  idleTimeoutMs: number;
}

interface Settings {
  branding: Branding;
  passwordPolicy: PasswordPolicy;
  sessionPolicy: SessionPolicy;
}

interface SignInPage {
  organizationName: string;
  applicationName: string;
  branding: Branding;
  request: Record<string, unknown>;
}

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Organization settings: branding, password policy, session timeout', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let ownerAdministratorId: string;
  let clientId: string;
  let endUserCookie: string;

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  const adminSignIn = (email: string, password: string): Promise<Response> =>
    instance.request('/api/administrators/sign-in', { method: 'POST', body: { email, password } });

  const settings = (cookie?: string): Promise<Response> =>
    instance.request('/api/organization/settings', {
      headers: cookie ? { cookie } : undefined,
      redirect: 'manual',
    });

  const settingsView = async (cookie: string): Promise<Settings> => {
    const res = await settings(cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as Settings;
  };

  const updateSettings = (cookie: string, body: unknown): Promise<Response> =>
    instance.request('/api/organization/settings', {
      method: 'PUT',
      headers: { cookie },
      body,
      redirect: 'manual',
    });

  const signUp = (email: string, password: string): Promise<Response> =>
    instance.request('/api/end-users/sign-up', { method: 'POST', body: { email, password } });

  const auditEvents = async (cookie: string): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie } });
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

    const owner = await adminSignIn(OWNER.email, OWNER.password);
    expect(owner.status).toBe(200);
    ownerCookie = cookieFrom(owner);
    ownerAdministratorId = ((await owner.json()) as { administratorId: string }).administratorId;

    // A Member: invited by the Owner, sets their own password, signs in.
    const invited = await instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { email: MEMBER.email, role: 'member' },
    });
    expect(invited.status).toBe(201);
    const inviteMail = (await instance.capturedEmails())
      .filter((mail) => mail.to === MEMBER.email && /invit/i.test(mail.subject))
      .at(-1);
    const accepted = await instance.request('/api/administrators/invitations/accept', {
      method: 'POST',
      body: { token: tokenFromLink(linkFromBody(inviteMail!.body)), ...MEMBER },
    });
    expect(accepted.status).toBe(201);
    memberCookie = cookieFrom(await adminSignIn(MEMBER.email, MEMBER.password));

    // A public Application, for the hosted sign-in page and the Account Center.
    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Mobile', type: 'spa' },
    });
    expect(registered.status).toBe(201);
    const application = ((await registered.json()) as { application: { id: string; clientId: string } })
      .application;
    clientId = application.clientId;
    const added = await instance.request(`/api/applications/${application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: REDIRECT },
    });
    expect(added.status).toBe(201);

    // A verified End User with a live Session.
    expect((await signUp(END_USER.email, END_USER.password)).status).toBe(201);
    const verification = (await instance.capturedEmails())
      .filter((mail) => mail.to === END_USER.email && /verify/i.test(mail.subject))
      .at(-1);
    await fetch(linkFromBody(verification!.body), { redirect: 'manual' });

    const { verifier, challenge } = pkce();
    const signIn = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'openid email',
        state: 'branding',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      body: END_USER,
    });
    expect(signIn.status).toBe(302);
    endUserCookie = cookieFrom(signIn);
    void verifier;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('requires an Administrator session to read settings', async () => {
    expect((await settings()).status).toBe(401);
    expect((await settings('identik_admin_session=garbage')).status).toBe(401);
  });

  it('exposes Organization-scoped defaults and nothing instance-scoped', async () => {
    const view = await settingsView(ownerCookie);

    expect(Object.keys(view).sort()).toEqual(['branding', 'passwordPolicy', 'sessionPolicy']);
    expect(view.branding).toEqual({
      name: ORGANIZATION_NAME,
      logoUrl: null,
      primaryColor: '#2563eb',
      secondaryColor: '#1e40af',
    });
    expect(view.passwordPolicy).toEqual({
      minLength: 8,
      requireUppercase: false,
      requireLowercase: false,
      requireDigit: false,
      requireSymbol: false,
    });
    expect(view.sessionPolicy).toEqual({ idleTimeoutMs: THIRTY_DAYS_MS });
  });

  it('is Member-visible but Owner-editable', async () => {
    expect((await settingsView(memberCookie)).branding.name).toBe(ORGANIZATION_NAME);

    const refused = await updateSettings(memberCookie, { branding: { name: 'Hijacked' } });
    expect(refused.status).toBe(403);
    expect((await settingsView(ownerCookie)).branding.name).toBe(ORGANIZATION_NAME);
  });

  it('renders Owner-edited branding on the hosted pages and the Account Center', async () => {
    const branding: Branding = {
      name: 'Zotac Identity',
      logoUrl: 'https://cdn.example.com/zotac-logo.png',
      primaryColor: '#ff6600',
      secondaryColor: '#003366',
    };
    const updated = await updateSettings(ownerCookie, { branding });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as Settings).branding).toEqual(branding);

    // Hosted sign-up page data.
    const signUpPage = await instance.request('/api/end-users/sign-up');
    expect(((await signUpPage.json()) as { branding: Branding }).branding).toEqual(branding);

    // Hosted sign-in page data (the authorization endpoint's page outcome).
    const authorize = await instance.request('/api/oidc/authorize', {
      query: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'openid email',
        state: 'page',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      },
    });
    expect(authorize.status).toBe(200);
    const page = (await authorize.json()) as SignInPage;
    expect(page.organizationName).toBe(ORGANIZATION_NAME);
    expect(page.branding).toEqual(branding);

    // Hosted forgot-password / reset pages.
    await instance.request('/api/end-users/forgot-password', {
      method: 'POST',
      body: { email: END_USER.email },
    });
    const resetMail = (await instance.capturedEmails())
      .filter((mail) => mail.to === END_USER.email && /reset/i.test(mail.subject))
      .at(-1);
    const resetPage = await instance.request('/api/end-users/reset-password', {
      query: { token: tokenFromLink(linkFromBody(resetMail!.body)) },
    });
    expect(((await resetPage.json()) as { branding: Branding }).branding).toEqual(branding);

    // Account Center.
    const accountCenter = await instance.request('/api/account-center', {
      headers: { cookie: endUserCookie },
    });
    expect(accountCenter.status).toBe(200);
    expect(((await accountCenter.json()) as { branding: Branding }).branding).toEqual(branding);
  });

  it('refuses to let any Organization-scoped edit reach instance-scoped trust fabric', async () => {
    const before = await settingsView(ownerCookie);

    // Unknown top-level keys — the instance-scoped trust fabric — are refused.
    for (const key of ['smtp', 'signingKeys', 'externalProviders', 'database']) {
      const refused = await updateSettings(ownerCookie, { [key]: { host: 'mail.evil.example' } });
      expect(refused.status, key).toBe(400);
    }

    // An unknown key nested inside an allowed section is refused too.
    const nested = await updateSettings(ownerCookie, {
      branding: { name: 'Sneaky', smtpHost: 'mail.evil.example' },
    });
    expect(nested.status).toBe(400);

    // A batch mixing a real edit with an instance key is refused wholesale.
    const mixed = await updateSettings(ownerCookie, {
      branding: { name: 'Changed' },
      signingKeys: { rotate: true },
    });
    expect(mixed.status).toBe(400);

    expect((await settingsView(ownerCookie)).branding).toEqual(before.branding);
  });

  it('records every settings change as an audit event', async () => {
    const events = await auditEvents(ownerCookie);
    const branding = events.find((event) => event.kind === 'organization.branding.updated');
    expect(branding).toBeDefined();
    expect(branding!.actor).toBe(ownerAdministratorId);
    expect(branding!.detail).toMatchObject({ name: 'Zotac Identity', primaryColor: '#ff6600' });
  });

  it('enforces the per-Organization password policy at sign-up', async () => {
    const updated = await updateSettings(ownerCookie, {
      passwordPolicy: { minLength: 12, requireUppercase: true, requireDigit: true },
    });
    expect(updated.status).toBe(200);

    const weak = await signUp('weak@example.com', 'abcdefghij12');
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error: string }).error).toBe('password_too_weak');

    const tooShort = await signUp('weak2@example.com', 'Abcdefgh12');
    expect(tooShort.status).toBe(400);

    // A refused sign-up leaves no Unverified Reservation behind.
    const reservations = (await auditEvents(ownerCookie)).filter(
      (event) =>
        event.kind === 'identity.reservation.created' && event.detail.email === 'weak@example.com',
    );
    expect(reservations).toHaveLength(0);

    const strong = await signUp('strong@example.com', 'StrongPassword12');
    expect(strong.status).toBe(201);
  });

  it('enforces the password policy at password change', async () => {
    const weak = await instance.request('/api/account-center/password', {
      method: 'POST',
      headers: { cookie: endUserCookie },
      body: { currentPassword: END_USER.password, newPassword: 'weakpassword' },
    });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error: string }).error).toBe('password_too_weak');

    const strong = await instance.request('/api/account-center/password', {
      method: 'POST',
      headers: { cookie: endUserCookie },
      body: { currentPassword: END_USER.password, newPassword: 'NewStrongPass12' },
    });
    expect(strong.status).toBe(200);
  });
});

describe('Organization session timeout: idle expiry, activity refreshes', () => {
  let instance: Instance;
  let ownerCookie: string;
  let clientId: string;

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
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
    ownerCookie = cookieFrom(owner);

    // Two seconds of idle, set through the Management API by the Owner.
    const policy = await instance.request('/api/organization/settings', {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: { sessionPolicy: { idleTimeoutMs: 2000 } },
    });
    expect(policy.status).toBe(200);

    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Mobile', type: 'spa' },
    });
    const application = ((await registered.json()) as { application: { id: string; clientId: string } })
      .application;
    clientId = application.clientId;
    await instance.request(`/api/applications/${application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: REDIRECT },
    });

    expect((await instance.request('/api/end-users/sign-up', { method: 'POST', body: END_USER })).status).toBe(201);
    const verification = (await instance.capturedEmails())
      .filter((mail) => mail.to === END_USER.email && /verify/i.test(mail.subject))
      .at(-1);
    await fetch(linkFromBody(verification!.body), { redirect: 'manual' });
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('lapses an idle Session and refreshes the window on activity', async () => {
    const { verifier, challenge } = pkce();
    const signIn = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'openid email',
        state: 'idle',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      body: END_USER,
    });
    expect(signIn.status).toBe(302);
    void verifier;
    const cookie = cookieFrom(signIn);

    const accountCenter = (): Promise<Response> =>
      instance.request('/api/account-center', { headers: { cookie }, redirect: 'manual' });

    expect((await accountCenter()).status).toBe(200);

    // Activity inside the window refreshes it: the second visit happens after
    // more than the original window has elapsed since sign-in, and still lives.
    await sleep(1200);
    expect((await accountCenter()).status).toBe(200);
    await sleep(1200);
    expect((await accountCenter()).status).toBe(200);

    // Now truly idle past the window: the Session lapses without a scheduler.
    await sleep(2600);
    expect((await accountCenter()).status).toBe(401);

    // The idle death is audited like any other liveness check would be at the
    // credential gates; at minimum the Session is simply gone from resolution.
    const audit = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
    expect(audit.status).toBe(200);
    const sessionPolicyEvents = ((await audit.json()) as { events: AuditEventView[] }).events.filter(
      (event) => event.kind === 'organization.session_policy.updated',
    );
    expect(sessionPolicyEvents).toHaveLength(1);
    expect(sessionPolicyEvents[0]!.detail).toMatchObject({ idleTimeoutMs: 2000 });
  });
});
