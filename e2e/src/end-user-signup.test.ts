import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 03 — End-User sign-up with the email verification gate. A visitor
 * signs up with email + password; an inert Unverified Reservation holds the
 * email (ADR-0011) until the verification link proves mailbox control and
 * activates the Identity. Everything is driven black-box through Seam 1 (the
 * HTTP surface) and Seam 2 (captured email); the audit surface — itself part
 * of the HTTP surface — is how the reservation's inert state and its later
 * activation are observed. Email existence is never confirmed at the HTTP
 * layer: the mailbox is the only place the accepted/refused distinction
 * appears (ADR-0005).
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const END_USER_EMAIL = 'mohamed@example.com';
const END_USER_PASSWORD = 'end user password 123';

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

function auditDetail(event: AuditEventView): Record<string, unknown> {
  return event.detail ?? {};
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('End-User sign-up with the email verification gate', () => {
  let instance: Instance;
  let adminCookie: string;

  const signUp = (email: string, password: string): Promise<Response> =>
    instance.request('/api/end-users/sign-up', { method: 'POST', body: { email, password } });

  const emailsTo = async (address: string) =>
    (await instance.capturedEmails()).filter((email) => email.to === address);

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie: adminCookie } });
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

    const signIn = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(signIn.status).toBe(200);
    adminCookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('the hosted sign-up page is reachable over HTTP and carries the Organization name', async () => {
    const info = await instance.request('/api/end-users/sign-up');
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({ organizationName: ORGANIZATION_NAME });

    const page = await instance.request('/end-users/sign-up');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
  });

  it('sign-up with a new email is accepted with a uniform response', async () => {
    const res = await signUp(END_USER_EMAIL, END_USER_PASSWORD);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'check-your-mailbox' });
  });

  it('a verification email arrives via the outbound mail boundary and carries a link', async () => {
    const mails = (await emailsTo(END_USER_EMAIL)).filter((mail) => mail.subject.includes('Verify'));
    expect(mails).toHaveLength(1);
    const link = linkFromBody(mails[0]!.body);
    expect(link).toContain('/api/end-users/verify-email?token=');
  });

  it('the created reservation is inert: recorded as unverified, not activated', async () => {
    const events = await auditEvents();
    const created = events.filter((event) => event.kind === 'identity.reservation.created');
    expect(created).toHaveLength(1);
    expect(auditDetail(created[0]!)).toMatchObject({ email: END_USER_EMAIL });
    expect(events.filter((event) => event.kind === 'identity.verification.completed')).toHaveLength(
      0,
    );
  });

  it('clicking the verification link activates the Identity and lands on the hosted result page', async () => {
    const mails = (await emailsTo(END_USER_EMAIL)).filter((mail) => mail.subject.includes('Verify'));
    const link = linkFromBody(mails.at(-1)!.body);

    const click = await clickLink(link);
    expect(click.status).toBe(302);
    expect(outcomeFrom(click.location)).toBe('verified');
    expect(click.location).toContain('/end-users/verify-email/result');

    const page = await fetch(new URL(click.location!, instance.url).toString());
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');

    const events = await auditEvents();
    const verified = events.filter((event) => event.kind === 'identity.verification.completed');
    expect(verified).toHaveLength(1);
    expect(auditDetail(verified[0]!)).toMatchObject({ email: END_USER_EMAIL });
  });

  it('the verification token is single-use: a second click is invalid', async () => {
    const mails = (await emailsTo(END_USER_EMAIL)).filter((mail) => mail.subject.includes('Verify'));
    const link = linkFromBody(mails.at(-1)!.body);

    const click = await clickLink(link);
    expect(click.status).toBe(302);
    expect(outcomeFrom(click.location)).toBe('invalid');
  });

  it('a garbage or missing token is invalid', async () => {
      const garbage = await clickLink(`${instance.url}/api/end-users/verify-email?token=not-a-real-token`);
    expect(garbage.status).toBe(302);
    expect(outcomeFrom(garbage.location)).toBe('invalid');

    const missing = await clickLink(`${instance.url}/api/end-users/verify-email`);
    expect(missing.status).toBe(302);
    expect(outcomeFrom(missing.location)).toBe('invalid');
  });

  it('sign-up with an existing (verified) email is refused — the "sign in instead" message reaches the mailbox, not the HTTP layer', async () => {
    const accepted = await signUp('zainab@example.com', END_USER_PASSWORD);
    expect(accepted.status).toBe(201);
    const acceptedBody = await accepted.json();

    const res = await signUp(END_USER_EMAIL, 'another password 456');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(acceptedBody);

    const refusal = (await emailsTo(END_USER_EMAIL)).find((mail) =>
      mail.subject.includes('already have an identity'),
    );
    expect(refusal).toBeDefined();
    expect(refusal!.body).toContain('An identity with this email already exists');
    expect(refusal!.body).toContain('sign in instead');

    const events = await auditEvents();
    const refused = events.filter(
      (event) =>
        event.kind === 'identity.signup.refused' && auditDetail(event).email === END_USER_EMAIL,
    );
    expect(refused).toHaveLength(1);
  });

  it('a duplicate sign-up while the reservation is still unverified gets the same refusal — no fresh verification link is re-sent (pre-claim healing is the mailbox owner act, ticket 04)', async () => {
    await signUp('sara@example.com', END_USER_PASSWORD);
    let mails = (await emailsTo('sara@example.com')).filter((mail) =>
      mail.subject.includes('Verify'),
    );
    expect(mails).toHaveLength(1);

    // A second sign-up with the same unclaimed email: refused identically.
    const res = await signUp('sara@example.com', 'a different password 789');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'check-your-mailbox' });

    // No fresh verification link — only the refusal reached the mailbox.
    mails = (await emailsTo('sara@example.com')).filter((mail) => mail.subject.includes('Verify'));
    expect(mails).toHaveLength(1);
    const refusal = (await emailsTo('sara@example.com')).find((mail) =>
      mail.subject.includes('already have an identity'),
    );
    expect(refusal).toBeDefined();
    expect(refusal!.body).toContain('sign in instead');

    const events = await auditEvents();
    const refused = events.filter(
      (event) =>
        event.kind === 'identity.signup.refused' && auditDetail(event).email === 'sara@example.com',
    );
    expect(refused).toHaveLength(1);

    // The original link still works: one mailbox proof, one activation.
    const click = await clickLink(linkFromBody(mails[0]!.body));
    expect(outcomeFrom(click.location)).toBe('verified');
  });

  it('sign-up responses are uniform in shape whether the email exists or not', async () => {
    const accepted = await signUp('shape-new@example.com', END_USER_PASSWORD);
    const refused = await signUp(END_USER_EMAIL, END_USER_PASSWORD);

    expect(refused.status).toBe(accepted.status);
    expect(refused.headers.get('content-type')).toBe(accepted.headers.get('content-type'));
    expect(await refused.json()).toEqual(await accepted.json());
  });

  it('sign-up responses are uniform in timing whether the email exists or not', async () => {
    // Warm both paths (module init, sqlite pages) before measuring.
    await signUp('timing-warmup@example.com', END_USER_PASSWORD);
    await signUp(END_USER_EMAIL, END_USER_PASSWORD);

    const fresh: number[] = [];
    const existing: number[] = [];
    for (let i = 0; i < 5; i++) {
      const freshStart = performance.now();
      expect((await signUp(`timing-${i}@example.com`, END_USER_PASSWORD)).status).toBe(201);
      fresh.push(performance.now() - freshStart);

      const existingStart = performance.now();
      expect((await signUp(END_USER_EMAIL, END_USER_PASSWORD)).status).toBe(201);
      existing.push(performance.now() - existingStart);
    }

    const drift = Math.abs(median(fresh) - median(existing));
    expect(drift).toBeLessThan(50);
  });

  it('email uniqueness is case-insensitive: a differently-cased duplicate is the same identity', async () => {
    const res = await signUp('Mohamed@Example.com', END_USER_PASSWORD);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'check-your-mailbox' });

    const refusal = (await emailsTo(END_USER_EMAIL))
      .filter((mail) => mail.subject.includes('already have an identity'))
      .at(-1);
    expect(refusal).toBeDefined();

    const events = await auditEvents();
    const reservations = events.filter(
      (event) =>
        event.kind === 'identity.reservation.created' &&
        auditDetail(event).email === END_USER_EMAIL,
    );
    expect(reservations).toHaveLength(1);
  });

  it('the reservation is inert until verified: a duplicate sign-up cannot smuggle a fresh link to a pre-claimed email', async () => {
    // An attacker pre-claims an email. The mailbox's true owner signs up and
    // is refused — no verification link is re-sent for the attacker's
    // reservation, so the owner's click can never activate the attacker's
    // password. Healing is the owner's own reset-flow act (ticket 04).
    await signUp('prey@example.com', 'attacker password 123');
    const owner = await signUp('prey@example.com', 'owner password 456');
    expect(owner.status).toBe(201);

    const verification = (await emailsTo('prey@example.com')).filter((mail) =>
      mail.subject.includes('Verify'),
    );
    expect(verification).toHaveLength(1);
    const refusal = (await emailsTo('prey@example.com')).filter((mail) =>
      mail.subject.includes('already have an identity'),
    );
    expect(refusal).toHaveLength(1);
  });
});

describe('verification token expiry', () => {
  it('an expired verification link is invalid', async () => {
    const instance = await Instance.start(BACKEND_DIST, {
      IDENTIK_VERIFICATION_TOKEN_TTL_MS: '500',
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

      const signUp = await instance.request('/api/end-users/sign-up', {
        method: 'POST',
        body: { email: 'late@example.com', password: END_USER_PASSWORD },
      });
      expect(signUp.status).toBe(201);

      const mails = (await instance.capturedEmails()).filter((mail) =>
        mail.to === 'late@example.com' && mail.subject.includes('Verify'),
      );
      const link = linkFromBody(mails.at(-1)!.body);

      await new Promise((resolve) => setTimeout(resolve, 700));

      const click = await clickLink(link);
      expect(click.status).toBe(302);
      expect(outcomeFrom(click.location)).toBe('invalid');
    } finally {
      await instance.stop();
    }
  });
});
