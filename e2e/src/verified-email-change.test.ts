import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 19 — Account Center verified email change (ADR-0008, ADR-0005,
 * ADR-0011, ADR-0018). An authenticated End User asks to move their handle to
 * a new address; verification mail goes to the *new* address, and the change
 * takes effect only once that mailbox is proven. Until then the old handle
 * stays active untouched. The new address must be unique in the Organization —
 * a verified Identity or an inert Unverified Reservation holding it refuses
 * the change with uniform messaging. Links are single-use and expiring; an
 * abandoned request changes nothing. Everything is observed over Seam 1
 * (HTTP) and Seam 2 (captured email) only.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const OTHER = { email: 'layla@example.com', password: 'other user password 123' };
const RESERVED = 'reserved@example.com';
const NEW_EMAIL = 'mohamed.new@example.com';
const SECOND_NEW_EMAIL = 'mohamed.second@example.com';
const REDIRECT = 'https://zotac.example.com/oidc/callback';

interface AccountCenterView {
  organizationName: string;
  identity: { email: string };
  pendingEmail: string | null;
  currentSessionId: string;
}

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface SignInPage {
  organizationName: string;
  applicationName: string;
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in email body');
  return match[0];
}

function outcomeFrom(location: string | null): string | null {
  if (!location) return null;
  const resolved = location.startsWith('http') ? location : `http://127.0.0.1${location}`;
  return new URL(resolved).searchParams.get('outcome');
}

async function clickLink(link: string): Promise<{ status: number; location: string | null }> {
  const res = await fetch(link, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Account Center verified email change', () => {
  let instance: Instance;
  let ownerCookie: string;
  let endUserCookie: string;
  let clientId: string;

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  const signIn = async (
    email: string,
    password: string,
  ): Promise<{ status: number; cookie: string; code: string | null }> => {
    const { challenge } = pkce();
    const res = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'openid email',
        state: randomBytes(8).toString('base64url'),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      body: { email, password },
    });
    if (res.status !== 302) return { status: res.status, cookie: '', code: null };
    return {
      status: res.status,
      cookie: cookieFrom(res),
      code: new URL(res.headers.get('location')!).searchParams.get('code'),
    };
  };

  const signUp = (email: string, password: string): Promise<Response> =>
    instance.request('/api/end-users/sign-up', { method: 'POST', body: { email, password } });

  const signUpAndVerify = async (endUser: { email: string; password: string }): Promise<void> => {
    expect((await signUp(endUser.email, endUser.password)).status).toBe(201);
    const mail = (await instance.capturedEmails())
      .filter((entry) => entry.to === endUser.email && /verify/i.test(entry.subject))
      .at(-1);
    await fetch(linkFromBody(mail!.body), { redirect: 'manual' });
  };

  const accountCenterView = async (cookie: string): Promise<AccountCenterView> => {
    const res = await instance.request('/api/account-center', { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as AccountCenterView;
  };

  const requestChange = (cookie: string, newEmail: string): Promise<Response> =>
    instance.request('/api/account-center/email', {
      method: 'POST',
      headers: { cookie },
      body: { newEmail },
      redirect: 'manual',
    });

  const mailsTo = async (address: string) =>
    (await instance.capturedEmails()).filter((mail) => mail.to === address);

  const changeLinkTo = async (address: string): Promise<string> => {
    const mail = (await mailsTo(address))
      .filter((entry) => entry.body.includes('/api/end-users/change-email?token='))
      .at(-1);
    if (!mail) throw new Error(`no change-email link delivered to ${address}`);
    return linkFromBody(mail.body);
  };

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
    ownerCookie = cookieFrom(owner);

    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Zotac', type: 'spa' },
    });
    const application = ((await registered.json()) as { application: { id: string; clientId: string } })
      .application;
    clientId = application.clientId;
    await instance.request(`/api/applications/${application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: REDIRECT },
    });

    await signUpAndVerify(END_USER);
    await signUpAndVerify(OTHER);
    // A claimed-but-unverified reservation: the email is held inertly (ADR-0011).
    expect((await signUp(RESERVED, 'reserved user password 123')).status).toBe(201);

    endUserCookie = (await signIn(END_USER.email, END_USER.password)).cookie;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('requires an authenticated Session to request a change', async () => {
    const anonymous = await requestChange('', NEW_EMAIL);
    expect(anonymous.status).toBe(401);

    const garbage = await requestChange('identik_sso_session=garbage', NEW_EMAIL);
    expect(garbage.status).toBe(401);
  });

  it('delivers verification to the new address while the old handle stays active', async () => {
    const res = await requestChange(endUserCookie, NEW_EMAIL);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'check-your-mailbox' });

    // The proof travels to the new mailbox, not the old one.
    const link = await changeLinkTo(NEW_EMAIL);
    expect(link).toContain('/api/end-users/change-email?token=');
    const oldMailbox = (await mailsTo(END_USER.email)).filter((mail) =>
      mail.body.includes('/api/end-users/change-email?token='),
    );
    expect(oldMailbox).toHaveLength(0);

    // Nothing has changed yet: the handle is still the old address, with the
    // requested one only pending.
    const view = await accountCenterView(endUserCookie);
    expect(view.identity.email).toBe(END_USER.email);
    expect(view.pendingEmail).toBe(NEW_EMAIL);

    // The old handle still authenticates (ADR-0005: the change is not effective
    // until proven).
    const oldHandle = await signIn(END_USER.email, END_USER.password);
    expect(oldHandle.status).toBe(302);
  });

  it('applies the change only once the new mailbox is proven', async () => {
    const link = await changeLinkTo(NEW_EMAIL);
    const click = await clickLink(link);
    expect(click.status).toBe(302);
    expect(outcomeFrom(click.location)).toBe('changed');

    const view = await accountCenterView(endUserCookie);
    expect(view.identity.email).toBe(NEW_EMAIL);
    expect(view.pendingEmail).toBeNull();

    // The new handle now authenticates and the old one is gone.
    expect((await signIn(NEW_EMAIL, END_USER.password)).status).toBe(302);
    expect((await signIn(END_USER.email, END_USER.password)).status).toBe(401);
  });

  it('a verification link is single-use', async () => {
    const link = await changeLinkTo(NEW_EMAIL);
    const again = await clickLink(link);
    expect(again.status).toBe(302);
    expect(outcomeFrom(again.location)).toBe('invalid');

    const view = await accountCenterView(endUserCookie);
    expect(view.identity.email).toBe(NEW_EMAIL);
  });

  it('refuses an address held by a verified Identity, with uniform messaging', async () => {
    const available = await requestChange(endUserCookie, SECOND_NEW_EMAIL);
    const claimed = await requestChange(endUserCookie, OTHER.email);
    expect(claimed.status).toBe(available.status);
    expect(await claimed.json()).toEqual(await available.json());

    // No change-email link is issued for the claimed address; the refusal
    // reaches its mailbox instead. The requester is untouched.
    const claimedLinks = (await mailsTo(OTHER.email)).filter((mail) =>
      mail.body.includes('/api/end-users/change-email?token='),
    );
    expect(claimedLinks).toHaveLength(0);

    const view = await accountCenterView(endUserCookie);
    expect(view.identity.email).toBe(NEW_EMAIL);
    expect(view.pendingEmail).toBe(SECOND_NEW_EMAIL);
  });

  it('refuses a claimed-but-unverified reservation identically', async () => {
    const claimed = await requestChange(endUserCookie, RESERVED);
    expect(claimed.status).toBe(202);
    expect(await claimed.json()).toEqual({ status: 'check-your-mailbox' });

    const reservationLinks = (await mailsTo(RESERVED)).filter((mail) =>
      mail.body.includes('/api/end-users/change-email?token='),
    );
    expect(reservationLinks).toHaveLength(0);

    const view = await accountCenterView(endUserCookie);
    expect(view.identity.email).toBe(NEW_EMAIL);
  });

  it('records requests, refusals, and completions as audit events', async () => {
    const events = await auditEvents();

    const requested = events.filter((event) => event.kind === 'identity.email_change.requested');
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(requested[0]!.actor).toBe('end-user');
    expect(requested.some((event) => event.detail.newEmail === NEW_EMAIL)).toBe(true);

    const completed = events.filter((event) => event.kind === 'identity.email_change.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.detail).toMatchObject({ email: NEW_EMAIL, previousEmail: END_USER.email });

    const refused = events.filter((event) => event.kind === 'identity.email_change.refused');
    expect(refused.some((event) => event.detail.newEmail === OTHER.email)).toBe(true);
    expect(refused.some((event) => event.detail.newEmail === RESERVED)).toBe(true);
  });

  it('anonymizing an Identity destroys its address in another Identity’s email-change trail', async () => {
    const list = await instance.request('/api/identities', { headers: { cookie: ownerCookie } });
    const identities = ((await list.json()) as {
      identities: Array<{ id: string; email: string }>;
    }).identities;
    const other = identities.find((identity) => identity.email === OTHER.email);
    expect(other).toBeDefined();

    const anonymized = await instance.request(`/api/identities/${other!.id}/anonymize`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { confirm: true },
    });
    expect(anonymized.status).toBe(200);

    // The refusal event above named OTHER's address from the requester's trail;
    // after anonymization no trace of that address may survive (ADR-0007).
    const leaked = (await auditEvents()).filter((event) =>
      JSON.stringify(event.detail).includes(OTHER.email),
    );
    expect(leaked).toHaveLength(0);
  });
});

describe('email change token expiry', () => {
  it('an expired change link is invalid and leaves the Identity untouched', async () => {
    const instance = await Instance.start(BACKEND_DIST, {
      IDENTIK_EMAIL_CHANGE_TOKEN_TTL_MS: '500',
    });
    try {
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
      const ownerCookie = cookieFrom(owner);
      const registered = await instance.request('/api/applications', {
        method: 'POST',
        headers: { cookie: ownerCookie },
        body: { name: 'Zotac', type: 'spa' },
      });
      const application = (
        (await registered.json()) as { application: { id: string; clientId: string } }
      ).application;
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

      const signIn = await instance.request('/api/oidc/authorize', {
        method: 'POST',
        redirect: 'manual',
        query: {
          client_id: application.clientId,
          redirect_uri: REDIRECT,
          response_type: 'code',
          scope: 'openid email',
          state: 'expiry',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        },
        body: END_USER,
      });
      expect(signIn.status).toBe(302);
      const cookie = cookieFrom(signIn);

      const changed = await instance.request('/api/account-center/email', {
        method: 'POST',
        headers: { cookie },
        body: { newEmail: NEW_EMAIL },
      });
      expect(changed.status).toBe(202);

      const mail = (await instance.capturedEmails())
        .filter(
          (entry) =>
            entry.to === NEW_EMAIL && entry.body.includes('/api/end-users/change-email?token='),
        )
        .at(-1);
      const link = linkFromBody(mail!.body);

      await sleep(700);

      const click = await clickLink(link);
      expect(click.status).toBe(302);
      expect(outcomeFrom(click.location)).toBe('invalid');

      const view = (await (
        await instance.request('/api/account-center', { headers: { cookie } })
      ).json()) as AccountCenterView;
      expect(view.identity.email).toBe(END_USER.email);
      expect(view.pendingEmail).toBeNull();
    } finally {
      await instance.stop();
    }
  });
});
