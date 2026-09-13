import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 04 — Forgot password, reset, and pre-claimed email healing. The
 * recovery flow is driven entirely through Seam 1 (HTTP) and Seam 2 (captured
 * email): "forgot password" answers uniformly whether or not the email exists;
 * where an Identity exists a reset link lands in the mailbox; clicking it and
 * setting a new password proves mailbox control, activates an Unverified
 * Reservation in the same act (ADR-0011), and revokes every Session.
 *
 * The headline arc (ADR-0005): an attacker pre-claims an email; the true
 * owner's sign-up is refused; the owner's reset link arrives in the owner's
 * own inbox; the owner sets a fresh password — no Administrator intervention.
 * With end-user sign-in arriving in ticket 09, "the attacker's credential is
 * dead" is observed here as: the reservation's activation is consumed by the
 * owner's reset (the attacker's original verification link no longer works)
 * and the reset completion is audited.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };

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

function tokenFromResetLink(link: string): string {
  const parsed = new URL(link);
  const token = parsed.searchParams.get('token');
  if (!token) throw new Error(`no token in reset link: ${link}`);
  return token;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('Forgot password, reset, and pre-claimed email healing', () => {
  let instance: Instance;
  let adminCookie: string;

  const signUp = (email: string, password: string): Promise<Response> =>
    instance.request('/api/end-users/sign-up', { method: 'POST', body: { email, password } });

  const forgotPassword = (email: string): Promise<Response> =>
    instance.request('/api/end-users/forgot-password', { method: 'POST', body: { email } });

  const emailsTo = async (address: string) =>
    (await instance.capturedEmails()).filter((email) => email.to === address);

  const resetEmailsTo = async (address: string) =>
    (await emailsTo(address)).filter((mail) => mail.subject.includes('Reset'));

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  const resetTokenFor = async (address: string): Promise<string> => {
    const mails = await resetEmailsTo(address);
    return tokenFromResetLink(linkFromBody(mails.at(-1)!.body));
  };

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);

    const ceremony = await instance.request('/api/setup', {
      method: 'POST',
      query: { token: instance.setupToken() },
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

  it('the forgot-password data endpoint carries the Organization name', async () => {
    const info = await instance.request('/api/end-users/forgot-password');
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ organizationName: ORGANIZATION_NAME });
  });

  it('forgot-password responds with identical shape whether the email exists or not', async () => {
    await signUp('shape-known@example.com', 'original password 123');

    const known = await forgotPassword('shape-known@example.com');
    const unknown = await forgotPassword('shape-unknown@example.com');

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.headers.get('content-type')).toBe(unknown.headers.get('content-type'));
    expect(await known.json()).toEqual({ status: 'check-your-mailbox' });
    expect(await unknown.json()).toEqual({ status: 'check-your-mailbox' });
  });

  it('forgot-password responds with uniform timing whether the email exists or not', async () => {
    // Warm both paths before measuring (module init, database connection
    // warm-up). Every known address is a real Identity so the exists branch is
    // actually exercised.
    await signUp('timing-warmup-known@example.com', 'original password 123');
    await forgotPassword('timing-warmup-known@example.com');
    await forgotPassword('timing-warmup-unknown@example.com');

    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      await signUp(`timing-known-${i}@example.com`, 'original password 123');

      const knownStart = performance.now();
      expect((await forgotPassword(`timing-known-${i}@example.com`)).status).toBe(202);
      known.push(performance.now() - knownStart);

      const unknownStart = performance.now();
      expect((await forgotPassword(`timing-unknown-${i}@example.com`)).status).toBe(202);
      unknown.push(performance.now() - unknownStart);
    }

    const drift = Math.abs(median(known) - median(unknown));
    expect(drift).toBeLessThan(50);
  });

  it('where an Identity exists, a reset email with a single-use link lands in the mailbox', async () => {
    await signUp('reset-target@example.com', 'original password 123');

    const res = await forgotPassword('reset-target@example.com');
    expect(res.status).toBe(202);

    const mails = await resetEmailsTo('reset-target@example.com');
    expect(mails).toHaveLength(1);
    const link = linkFromBody(mails[0]!.body);
    expect(link).toContain('/end-users/reset-password?token=');
  });

  it('the reset page reports a fresh token as valid and a garbage token as invalid', async () => {
    await signUp('reset-valid@example.com', 'original password 123');
    await forgotPassword('reset-valid@example.com');
    const token = await resetTokenFor('reset-valid@example.com');

    const valid = await instance.request('/api/end-users/reset-password', { query: { token } });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ organizationName: ORGANIZATION_NAME, valid: true });

    const garbage = await instance.request('/api/end-users/reset-password', {
      query: { token: 'not-a-real-token' },
    });
    expect(garbage.status).toBe(200);
    expect(await garbage.json()).toMatchObject({ organizationName: ORGANIZATION_NAME, valid: false });
  });

  it('completing a reset sets the new password and audits initiation and completion', async () => {
    await signUp('reset-complete@example.com', 'original password 123');
    await forgotPassword('reset-complete@example.com');
    const token = await resetTokenFor('reset-complete@example.com');

    const res = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token, password: 'brand new password 456' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'password-reset' });

    const events = await auditEvents();
    const requested = events.filter(
      (event) =>
        event.kind === 'identity.password_reset.requested' &&
        auditDetail(event).email === 'reset-complete@example.com',
    );
    expect(requested).toHaveLength(1);

    const completed = events.filter(
      (event) =>
        event.kind === 'identity.password_reset.completed' &&
        auditDetail(event).email === 'reset-complete@example.com',
    );
    expect(completed).toHaveLength(1);
  });

  it('a reset link is single-use: reusing it after completion is refused', async () => {
    await signUp('reset-single-use@example.com', 'original password 123');
    await forgotPassword('reset-single-use@example.com');
    const token = await resetTokenFor('reset-single-use@example.com');

    const first = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token, password: 'first new password 456' },
    });
    expect(first.status).toBe(200);

    const second = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token, password: 'second new password 789' },
    });
    expect(second.status).toBe(400);

    const page = await instance.request('/api/end-users/reset-password', { query: { token } });
    expect(await page.json()).toMatchObject({ organizationName: ORGANIZATION_NAME, valid: false });
  });

  it('the pre-claimed-email healing arc hands the Identity to the mailbox owner', async () => {
    const prey = 'prey@example.com';

    // The attacker pre-claims the mailbox with a password of their choosing.
    expect((await signUp(prey, 'attacker password 123')).status).toBe(201);
    const attackerLink = linkFromBody((await emailsTo(prey))[0]!.body);

    // The true owner signs up and is refused — no fresh verification link.
    expect((await signUp(prey, 'owner password 456')).status).toBe(201);

    // The owner recovers through their own mailbox.
    expect((await forgotPassword(prey)).status).toBe(202);
    const token = await resetTokenFor(prey);

    const completion = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token, password: 'owner chosen password 789' },
    });
    expect(completion.status).toBe(200);

    // The owner's reset proves mailbox control: the reservation activates, so
    // the attacker's original verification link is spent and can no longer
    // activate the Identity.
    const attackerClick = await fetch(attackerLink, { redirect: 'manual' });
    const location = attackerClick.headers.get('location') ?? '';
    expect(location).toContain('outcome=invalid');

    const events = await auditEvents();
    const healed = events.filter(
      (event) =>
        event.kind === 'identity.verification.completed' && auditDetail(event).email === prey,
    );
    expect(healed).toHaveLength(1);

    const completed = events.filter(
      (event) =>
        event.kind === 'identity.password_reset.completed' && auditDetail(event).email === prey,
    );
    expect(completed).toHaveLength(1);
  });

  it('a reset on an Unverified Reservation marks the email verified (mailbox proof is mailbox proof)', async () => {
    await signUp('unverified-heal@example.com', 'reservation password 123');
    await forgotPassword('unverified-heal@example.com');
    const token = await resetTokenFor('unverified-heal@example.com');

    const res = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: { token, password: 'new password 456' },
    });
    expect(res.status).toBe(200);

    const events = await auditEvents();
    const verified = events.filter(
      (event) =>
        event.kind === 'identity.verification.completed' &&
        auditDetail(event).email === 'unverified-heal@example.com',
    );
    expect(verified).toHaveLength(1);
  });

  it('forgot-password never sends a reset link for an email with no Identity', async () => {
    await forgotPassword('ghost@example.com');
    const mails = await emailsTo('ghost@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body).not.toContain('/end-users/reset-password?token=');
  });

  it('email uniqueness is case-insensitive for recovery too', async () => {
    await signUp('reset-case@example.com', 'original password 123');
    await forgotPassword('Reset-Case@Example.com');
    const mails = await resetEmailsTo('reset-case@example.com');
    expect(mails).toHaveLength(1);
  });
});

describe('reset token expiry', () => {
  it('an expired reset link is invalid and cannot set a password', async () => {
    const instance = await Instance.start(BACKEND_DIST, {
      IDENTIK_RESET_TOKEN_TTL_MS: '500',
    });
    try {
      const ceremony = await instance.request('/api/setup', {
        method: 'POST',
        query: { token: instance.setupToken() },
        body: { organizationName: ORGANIZATION_NAME, ...OWNER },
      });
      expect(ceremony.status).toBe(201);

      await instance.request('/api/end-users/sign-up', {
        method: 'POST',
        body: { email: 'late-reset@example.com', password: 'original password 123' },
      });
      await instance.request('/api/end-users/forgot-password', {
        method: 'POST',
        body: { email: 'late-reset@example.com' },
      });

      const mails = (await instance.capturedEmails()).filter(
        (mail) => mail.to === 'late-reset@example.com' && mail.subject.includes('Reset'),
      );
      const token = tokenFromResetLink(linkFromBody(mails.at(-1)!.body));

      await new Promise((resolve) => setTimeout(resolve, 700));

      const page = await instance.request('/api/end-users/reset-password', { query: { token } });
      expect(await page.json()).toMatchObject({ organizationName: ORGANIZATION_NAME, valid: false });

      const res = await instance.request('/api/end-users/reset-password', {
        method: 'POST',
        body: { token, password: 'too late password 456' },
      });
      expect(res.status).toBe(400);
    } finally {
      await instance.stop();
    }
  });
});
