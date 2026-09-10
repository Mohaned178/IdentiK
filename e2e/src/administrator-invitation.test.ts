import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 05 — Administrator invitation and Owner/Member roles (ADR-0021,
 * ADR-0008, ADR-0016). An Owner invites an Administrator by email; the
 * invitee sets their own password through the invitation link — the inviter
 * never chooses a credential. Invitations expire and are single-use. The
 * invited Administrator signs in through the dedicated Administrator sign-in
 * and receives a Membership scoped to the Organization with a role.
 * Invitation is Owner-only. Everything is observed through Seam 1 (HTTP) and
 * Seam 2 (captured email) only.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'layla chosen password 123', name: 'Layla' };
const SECOND_OWNER = {
  email: 'sara@example.com',
  password: 'sara chosen password 123',
  name: 'Sara',
};

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

function tokenFromLink(link: string): string {
  const parsed = new URL(link);
  const token = parsed.searchParams.get('token');
  if (!token) throw new Error(`no token in link: ${link}`);
  return token;
}

async function signIn(instance: Instance, email: string, password: string): Promise<Response> {
  return instance.request('/api/administrators/sign-in', { method: 'POST', body: { email, password } });
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('Administrator invitation and Owner/Member roles', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let memberInvitationToken: string;

  const invite = (cookie: string, body: Record<string, string>): Promise<Response> =>
    instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie },
      body,
    });

  const invitationInfo = (token: string | undefined): Promise<Response> =>
    instance.request('/api/administrators/invitations', {
      query: token === undefined ? {} : { token },
    });

  const acceptInvitation = (body: Record<string, string>): Promise<Response> =>
    instance.request('/api/administrators/invitations/accept', { method: 'POST', body });

  const invitationMails = async (address: string) =>
    (await instance.capturedEmails()).filter(
      (mail) => mail.to === address && /invit/i.test(mail.subject),
    );

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

    ownerCookie = cookieFrom(await signIn(instance, OWNER.email, OWNER.password));

    const issued = await invite(ownerCookie, { email: MEMBER.email, role: 'member' });
    expect(issued.status).toBe(201);

    const mails = await invitationMails(MEMBER.email);
    expect(mails).toHaveLength(1);
    memberInvitationToken = tokenFromLink(linkFromBody(mails[0]!.body));

    const accepted = await acceptInvitation({ token: memberInvitationToken, ...MEMBER });
    expect(accepted.status).toBe(201);

    memberCookie = cookieFrom(await signIn(instance, MEMBER.email, MEMBER.password));
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('the invitation email is delivered through the outbound mail boundary with an acceptance link', async () => {
    const mails = await invitationMails(MEMBER.email);
    expect(mails).toHaveLength(1);
    const link = linkFromBody(mails[0]!.body);
    expect(link).toContain('/administrators/accept-invitation?token=');
  });

  it('the hosted acceptance page and its data endpoint are reachable over HTTP', async () => {
    const page = await instance.request('/administrators/accept-invitation');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');

    const issued = await invite(ownerCookie, { email: 'probe@example.com', role: 'member' });
    expect(issued.status).toBe(201);
    const mails = await invitationMails('probe@example.com');
    const probeToken = tokenFromLink(linkFromBody(mails.at(-1)!.body));

    const info = await invitationInfo(probeToken);
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({
      organizationName: ORGANIZATION_NAME,
      email: 'probe@example.com',
      role: 'member',
      valid: true,
    });
  });

  it('the invited Administrator signs in via the dedicated sign-in with the password they set', async () => {
    const res = await signIn(instance, MEMBER.email, MEMBER.password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; organizationName: string };
    expect(body.role).toBe('member');
    expect(body.organizationName).toBe(ORGANIZATION_NAME);
  });

  it('an invitation link is single-use: reusing it after acceptance is refused', async () => {
    const first = await acceptInvitation({ token: memberInvitationToken, ...MEMBER });
    expect(first.status).toBe(400);

    const info = await invitationInfo(memberInvitationToken);
    expect(await info.json()).toMatchObject({ valid: false });
  });

  it('invitation creation is Owner-only: a Member attempting to invite is refused by the Management API', async () => {
    const res = await invite(memberCookie, { email: 'noura@example.com', role: 'member' });
    expect(res.status).toBe(403);
  });

  it('the role distinction is enforced: an Owner may invite and a Member may not', async () => {
    const owner = await signIn(instance, OWNER.email, OWNER.password);
    const ownerBody = (await owner.json()) as { role: string };
    expect(ownerBody.role).toBe('owner');

    const member = await signIn(instance, MEMBER.email, MEMBER.password);
    const memberBody = (await member.json()) as { role: string };
    expect(memberBody.role).toBe('member');
  });

  it('an Owner-role invitation grants the Owner role', async () => {
    const issued = await invite(ownerCookie, { email: SECOND_OWNER.email, role: 'owner' });
    expect(issued.status).toBe(201);

    const mails = await invitationMails(SECOND_OWNER.email);
    const token = tokenFromLink(linkFromBody(mails.at(-1)!.body));

    const accepted = await acceptInvitation({ token, ...SECOND_OWNER });
    expect(accepted.status).toBe(201);

    const res = await signIn(instance, SECOND_OWNER.email, SECOND_OWNER.password);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe('owner');
  });

  it('invitation issuance and acceptance are audit events', async () => {
    const events = await auditEvents(ownerCookie);

    const issued = events.filter(
      (event) =>
        event.kind === 'administrator.invitation.issued' &&
        auditDetail(event).email === MEMBER.email,
    );
    expect(issued).toHaveLength(1);
    expect(auditDetail(issued[0]!)).toMatchObject({ role: 'member' });

    const accepted = events.filter(
      (event) =>
        event.kind === 'administrator.invitation.accepted' &&
        auditDetail(event).email === MEMBER.email,
    );
    expect(accepted).toHaveLength(1);
    expect(auditDetail(accepted[0]!)).toMatchObject({ role: 'member' });
  });

  it('administration is invitation-only: no self-serve creation path exists on the HTTP surface', async () => {
    for (const path of ['/api/administrators/sign-up', '/api/administrators']) {
      const selfServe = await instance.request(path, {
        method: 'POST',
        body: { email: 'mallory@example.com', password: 'mallory password 123', name: 'Mallory' },
      });
      expect(selfServe.status).toBe(404);
    }

    const anonymousInvite = await instance.request('/api/administrators/invitations', {
      method: 'POST',
      body: { email: 'mallory@example.com', role: 'owner' },
    });
    expect(anonymousInvite.status).toBe(401);
  });

  it('an unknown or garbage invitation token is reported invalid and cannot create an Administrator', async () => {
    const info = await invitationInfo('not-a-real-token');
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ valid: false });

    const res = await acceptInvitation({
      token: 'not-a-real-token',
      name: 'Mallory',
      password: 'mallory password 123',
    });
    expect(res.status).toBe(400);
  });
});

describe('invitation token expiry', () => {
  it('an expired invitation link is invalid, cannot be accepted, and is audited', async () => {
    const instance = await Instance.start(BACKEND_DIST, {
      IDENTIK_INVITATION_TOKEN_TTL_MS: '500',
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

      const signInRes = await instance.request('/api/administrators/sign-in', {
        method: 'POST',
        body: { email: OWNER.email, password: OWNER.password },
      });
      const cookie = cookieFrom(signInRes);

      const issued = await instance.request('/api/administrators/invitations', {
        method: 'POST',
        headers: { cookie },
        body: { email: 'late@example.com', role: 'member' },
      });
      expect(issued.status).toBe(201);

      const mails = (await instance.capturedEmails()).filter(
        (mail) => mail.to === 'late@example.com' && /invit/i.test(mail.subject),
      );
      const token = tokenFromLink(linkFromBody(mails.at(-1)!.body));

      await new Promise((resolve) => setTimeout(resolve, 700));

      const info = await instance.request('/api/administrators/invitations', {
        query: { token },
      });
      expect(await info.json()).toMatchObject({ valid: false });

      // Presenting the dead link through the hosted page is itself the
      // observable expiry moment; it must be audited exactly once.
      const afterPage = await instance.request('/api/audit', { headers: { cookie } });
      const pageEvents = ((await afterPage.json()) as { events: AuditEventView[] }).events;
      expect(
        pageEvents.filter(
          (event) =>
            event.kind === 'administrator.invitation.expired' &&
            auditDetail(event).email === 'late@example.com',
        ),
      ).toHaveLength(1);

      const res = await instance.request('/api/administrators/invitations/accept', {
        method: 'POST',
        body: { token, name: 'Late', password: 'late password 123' },
      });
      expect(res.status).toBe(400);

      const audit = await instance.request('/api/audit', { headers: { cookie } });
      const events = ((await audit.json()) as { events: AuditEventView[] }).events;
      const expired = events.filter(
        (event) =>
          event.kind === 'administrator.invitation.expired' &&
          auditDetail(event).email === 'late@example.com',
      );
      expect(expired).toHaveLength(1);
    } finally {
      await instance.stop();
    }
  });
});
