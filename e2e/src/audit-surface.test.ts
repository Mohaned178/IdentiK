import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 08 — The unified audit surface (ADR-0020, ADR-0023). Observed only
 * through Seam 1 (the Management API over HTTP) and Seam 2 (captured email).
 *
 * Every security-relevant event recorded so far — bootstrap, invitations,
 * credential issuance and revocation, redirect URI changes, and the End-User
 * identity lifecycle — is visible in one surface with who/what/when. The
 * surface is filterable by actor, event kind, and time range so "who added
 * that URI, when?" is answerable directly. Members can view it; only
 * Administrator sessions can reach it; and it is the same Management API the
 * dashboard consumes, not a private back door.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'layla chosen password 123', name: 'Layla' };
const END_USER_EMAIL = 'mohamed@example.com';
const END_USER_PASSWORD = 'end user password 123';
const END_USER_NEW_PASSWORD = 'reset password 456';

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  actorName: string | null;
  actorEmail: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface SignInView {
  administratorId: string;
  organizationId: string;
  role: string;
}

interface ApplicationView {
  id: string;
  clientId: string;
  secrets: Array<{ id: string; label: string; revokedAt: string | null }>;
  redirectUris: Array<{ id: string; uri: string }>;
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

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('Unified audit surface', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let ownerId: string;
  let memberId: string;
  let applicationId: string;

  const audit = (cookie: string, query: Record<string, string> = {}): Promise<Response> =>
    instance.request('/api/audit', { headers: { cookie }, query });

  const auditEvents = async (
    cookie = ownerCookie,
    query: Record<string, string> = {},
  ): Promise<AuditEventView[]> => {
    const res = await audit(cookie, query);
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
    expect(owner.status).toBe(200);
    ownerCookie = cookieFrom(owner);
    ownerId = ((await owner.json()) as SignInView).administratorId;

    // Ticket 05: invitation issued by the Owner, accepted by the invitee.
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
      body: {
        token: tokenFromLink(linkFromBody(invitationMail!.body)),
        ...MEMBER,
      },
    });
    expect(accept.status).toBe(201);
    memberId = ((await accept.json()) as { administratorId: string }).administratorId;

    const member = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: MEMBER.email, password: MEMBER.password },
    });
    memberCookie = cookieFrom(member);

    // Ticket 06: Application registration and the credential lifecycle.
    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Zotac', type: 'web' },
    });
    expect(registered.status).toBe(201);
    const application = ((await registered.json()) as { application: ApplicationView }).application;
    applicationId = application.id;

    const extraSecret = await instance.request(`/api/applications/${applicationId}/secrets`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { label: 'unified-audit' },
    });
    expect(extraSecret.status).toBe(201);
    const secret = ((await extraSecret.json()) as { secret: { id: string } }).secret;
    const revoke = await instance.request(
      `/api/applications/${applicationId}/secrets/${secret.id}/revoke`,
      { method: 'POST', headers: { cookie: ownerCookie } },
    );
    expect(revoke.status).toBe(200);

    // Ticket 07: redirect URI changes.
    const added = await instance.request(`/api/applications/${applicationId}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: 'https://zotac.example.com/audit' },
    });
    expect(added.status).toBe(201);
    const redirectUri = ((await added.json()) as { redirectUri: { id: string } }).redirectUri;
    const updated = await instance.request(
      `/api/applications/${applicationId}/redirect-uris/${redirectUri.id}`,
      {
        method: 'PATCH',
        headers: { cookie: ownerCookie },
        body: { uri: 'https://zotac.example.com/audit-v2' },
      },
    );
    expect(updated.status).toBe(200);
    const removed = await instance.request(
      `/api/applications/${applicationId}/redirect-uris/${redirectUri.id}`,
      { method: 'DELETE', headers: { cookie: ownerCookie } },
    );
    expect(removed.status).toBe(200);

    // Tickets 03 and 04: the End-User identity lifecycle.
    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: { email: END_USER_EMAIL, password: END_USER_PASSWORD },
    });
    expect(signUp.status).toBe(201);
    const verificationMail = (await instance.capturedEmails()).find(
      (mail) => mail.to === END_USER_EMAIL && /verify/i.test(mail.subject),
    );
    const verified = await fetch(linkFromBody(verificationMail!.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);

    const forgot = await instance.request('/api/end-users/forgot-password', {
      method: 'POST',
      body: { email: END_USER_EMAIL },
    });
    expect(forgot.status).toBe(202);
    const resetMail = (await instance.capturedEmails()).find(
      (mail) => mail.to === END_USER_EMAIL && /reset/i.test(mail.subject),
    );
    const reset = await instance.request('/api/end-users/reset-password', {
      method: 'POST',
      body: {
        token: tokenFromLink(linkFromBody(resetMail!.body)),
        password: END_USER_NEW_PASSWORD,
      },
    });
    expect(reset.status).toBe(200);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('one surface carries every event family recorded so far, newest first', async () => {
    const events = await auditEvents();

    const kinds = new Set(events.map((event) => event.kind));
    for (const kind of [
      'bootstrap.completed',
      'administrator.invitation.issued',
      'administrator.invitation.accepted',
      'application.registered',
      'client_secret.generated',
      'client_secret.revoked',
      'redirect_uri.added',
      'redirect_uri.updated',
      'redirect_uri.removed',
      'identity.reservation.created',
      'identity.verification.completed',
      'identity.password_reset.requested',
      'identity.password_reset.completed',
    ]) {
      expect(kinds.has(kind), `expected ${kind} in the audit surface`).toBe(true);
    }

    for (const event of events) {
      expect(event.id).toBeTruthy();
      expect(event.kind).toBeTruthy();
      expect(event.actor).toBeTruthy();
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
      expect(event.detail).toBeTypeOf('object');
    }

    const times = events.map((event) => Date.parse(event.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('resolves an Administrator actor to a human while keeping the raw actor', async () => {
    const events = await auditEvents();

    const byOwner = events.find(
      (event) => event.kind === 'redirect_uri.added' && event.actor === ownerId,
    );
    expect(byOwner).toBeDefined();
    expect(byOwner!.actorName).toBe(OWNER.name);
    expect(byOwner!.actorEmail).toBe(OWNER.email);
    expect(byOwner!.detail).toMatchObject({ applicationId });

    const byInvitee = events.find((event) => event.kind === 'administrator.invitation.accepted');
    expect(byInvitee!.actor).toBe(memberId);
    expect(byInvitee!.actorName).toBe(MEMBER.name);

    const system = events.find((event) => event.kind === 'bootstrap.completed');
    expect(system!.actor).toBe('instance');
    expect(system!.actorName).toBeNull();
    expect(system!.actorEmail).toBeNull();
  });

  it('filters by event kind', async () => {
    const events = await auditEvents(ownerCookie, { kind: 'redirect_uri.updated' });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.kind === 'redirect_uri.updated')).toBe(true);
  });

  it('filters by actor', async () => {
    const ownerEvents = await auditEvents(ownerCookie, { actor: ownerId });
    expect(ownerEvents.length).toBeGreaterThan(0);
    expect(ownerEvents.every((event) => event.actor === ownerId)).toBe(true);
    expect(ownerEvents.some((event) => event.kind === 'client_secret.generated')).toBe(true);
    expect(ownerEvents.some((event) => event.kind === 'redirect_uri.added')).toBe(true);
    expect(ownerEvents.some((event) => event.kind === 'administrator.invitation.accepted')).toBe(
      false,
    );

    const systemEvents = await auditEvents(ownerCookie, { actor: 'instance' });
    expect(systemEvents.length).toBeGreaterThan(0);
    expect(systemEvents.every((event) => event.actor === 'instance')).toBe(true);
    expect(systemEvents.some((event) => event.kind === 'bootstrap.completed')).toBe(true);

    const endUserEvents = await auditEvents(ownerCookie, { actor: 'end-user' });
    expect(endUserEvents.length).toBeGreaterThan(0);
    expect(endUserEvents.some((event) => event.kind === 'identity.verification.completed')).toBe(
      true,
    );
  });

  it('filters by time range with inclusive bounds', async () => {
    const from = new Date().toISOString();
    const added = await instance.request(`/api/applications/${applicationId}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: 'https://zotac.example.com/audit-window' },
    });
    expect(added.status).toBe(201);
    const { redirectUri } = (await added.json()) as { redirectUri: { id: string } };
    const to = new Date().toISOString();

    const window = await auditEvents(ownerCookie, { from, to, kind: 'redirect_uri.added' });
    expect(window.some((event) => event.detail.uriId === redirectUri.id)).toBe(true);

    const beforeWindow = await auditEvents(ownerCookie, { to: from, kind: 'redirect_uri.added' });
    expect(beforeWindow.some((event) => event.detail.uriId === redirectUri.id)).toBe(false);

    const inWindow = window.find((event) => event.detail.uriId === redirectUri.id)!;
    const exact = await auditEvents(ownerCookie, {
      from: inWindow.occurredAt,
      to: inWindow.occurredAt,
      kind: 'redirect_uri.added',
    });
    expect(exact.some((event) => event.id === inWindow.id)).toBe(true);
  });

  it('refuses malformed or inverted time ranges instead of guessing', async () => {
    const malformed = await audit(ownerCookie, { from: 'not-a-date' });
    expect(malformed.status).toBe(400);

    const inverted = await audit(ownerCookie, {
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
    expect(inverted.status).toBe(400);
  });

  it('combines filters', async () => {
    const events = await auditEvents(ownerCookie, { actor: ownerId, kind: 'redirect_uri.removed' });
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every((event) => event.actor === ownerId && event.kind === 'redirect_uri.removed'),
    ).toBe(true);
  });

  it('Members can view the surface; anonymous callers cannot', async () => {
    const member = await audit(memberCookie);
    expect(member.status).toBe(200);
    const { events } = (await member.json()) as { events: AuditEventView[] };
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === 'redirect_uri.added')).toBe(true);

    const anonymous = await instance.request('/api/audit');
    expect(anonymous.status).toBe(401);
  });
});
