import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 07 — Redirect URI configuration and exact-match validation
 * (ADR-0010, ADR-0016, ADR-0019). Observed only through Seam 1 (the Management
 * API over HTTP) and the audit surface that sits on it.
 *
 * Owners add, edit, and remove redirect URIs on an Application. A URI is
 * accepted only as a concrete absolute URL: HTTPS anywhere, plain HTTP for
 * loopback development only, never a wildcard or a prefix pattern, never a
 * malformed component. The stored value is the exact-match target — there is
 * no matching mode other than equality. Every change is a first-class
 * security audit event naming the acting Administrator, the Application, the
 * URI, and the time, sitting in the same surface as credential events.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'layla chosen password 123', name: 'Layla' };

interface RedirectUriView {
  id: string;
  uri: string;
  createdAt: string;
  updatedAt: string | null;
}

interface ApplicationView {
  id: string;
  name: string;
  type: 'web' | 'spa';
  clientId: string;
  createdAt: string;
  secrets: Array<{ id: string; label: string; createdAt: string; revokedAt: string | null }>;
  redirectUris: RedirectUriView[];
}

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface SignInView {
  administratorId: string;
  organizationId: string;
  role: string;
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

describe('Redirect URI configuration and exact-match validation', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;
  let ownerId: string;
  let applicationId: string;

  const addRedirectUri = (cookie: string, uri: unknown): Promise<Response> =>
    instance.request(`/api/applications/${applicationId}/redirect-uris`, {
      method: 'POST',
      headers: { cookie },
      body: { uri },
    });

  const updateRedirectUri = (cookie: string, uriId: string, uri: unknown): Promise<Response> =>
    instance.request(`/api/applications/${applicationId}/redirect-uris/${uriId}`, {
      method: 'PATCH',
      headers: { cookie },
      body: { uri },
    });

  const removeRedirectUri = (cookie: string, uriId: string): Promise<Response> =>
    instance.request(`/api/applications/${applicationId}/redirect-uris/${uriId}`, {
      method: 'DELETE',
      headers: { cookie },
    });

  const getApplication = async (cookie = ownerCookie): Promise<ApplicationView> => {
    const res = await instance.request(`/api/applications/${applicationId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { application: ApplicationView }).application;
  };

  const auditEvents = async (cookie = ownerCookie): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  const storedUris = async (): Promise<string[]> =>
    (await getApplication()).redirectUris.map((entry) => entry.uri);

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

    const invited = await instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { email: MEMBER.email, role: 'member' },
    });
    expect(invited.status).toBe(201);
    const mails = (await instance.capturedEmails()).filter(
      (mail) => mail.to === MEMBER.email && /invit/i.test(mail.subject),
    );
    const invitationToken = tokenFromLink(linkFromBody(mails.at(-1)!.body));
    const accepted = await instance.request('/api/administrators/invitations/accept', {
      method: 'POST',
      body: { token: invitationToken, ...MEMBER },
    });
    expect(accepted.status).toBe(201);

    const member = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: MEMBER.email, password: MEMBER.password },
    });
    memberCookie = cookieFrom(member);

    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Zotac', type: 'web' },
    });
    expect(registered.status).toBe(201);
    applicationId = ((await registered.json()) as { application: ApplicationView }).application.id;
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('an Owner adds a redirect URI and it appears on the Application', async () => {
    const uri = 'https://zotac.example.com/oidc/callback';
    const res = await addRedirectUri(ownerCookie, uri);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { redirectUri: RedirectUriView };
    expect(body.redirectUri.uri).toBe(uri);
    expect(body.redirectUri.id).toBeTruthy();
    expect(body.redirectUri.createdAt).toBeTruthy();
    expect(body.redirectUri.updatedAt).toBeNull();

    const application = await getApplication();
    expect(application.redirectUris.map((entry) => entry.uri)).toContain(uri);

    const listed = await instance.request('/api/applications', { headers: { cookie: ownerCookie } });
    const applications = ((await listed.json()) as { applications: ApplicationView[] })
      .applications;
    expect(
      applications.find((app) => app.id === applicationId)?.redirectUris.map((entry) => entry.uri),
    ).toContain(uri);
  });

  it('the same URI written with a different scheme/host case is a duplicate, not a second entry', async () => {
    const res = await addRedirectUri(ownerCookie, 'HTTPS://ZOTAC.example.com/oidc/callback');
    expect(res.status).toBe(409);

    const count = (await storedUris()).filter(
      (uri) => uri.toLowerCase() === 'https://zotac.example.com/oidc/callback',
    );
    expect(count).toHaveLength(1);
  });

  it('non-HTTPS schemes other than loopback HTTP are refused', async () => {
    const before = await storedUris();
    for (const uri of [
      'http://zotac.example.com/callback',
      'http://127.0.0.1.evil.com/callback',
      'ftp://zotac.example.com/callback',
      'javascript:alert(1)',
    ]) {
      const res = await addRedirectUri(ownerCookie, uri);
      expect(res.status, `expected ${uri} to be refused`).toBe(400);
    }
    expect(await storedUris()).toEqual(before);
  });

  it('wildcard and pattern forms are never accepted', async () => {
    for (const uri of [
      'https://*.zotac.example.com/callback',
      'https://zotac.example.com/*',
      'https://zotac.example.com/callback/*',
      'https://zotac.example.com/*/callback',
      'https://zotac.example.com/callback?organization=*',
    ]) {
      const res = await addRedirectUri(ownerCookie, uri);
      expect(res.status, `expected ${uri} to be refused`).toBe(400);
    }
  });

  it('malformed URIs are refused with no partial write', async () => {
    const before = await storedUris();
    for (const uri of [
      'not a url',
      '/callback',
      'https://zotac.example.com:99999/callback',
      'https://user:password@zotac.example.com/callback',
      'https://zotac.example.com/callback#fragment',
      'https://zotac.example.com/callback#',
      '',
    ]) {
      const res = await addRedirectUri(ownerCookie, uri);
      expect(res.status, `expected ${JSON.stringify(uri)} to be refused`).toBe(400);
    }
    expect(await storedUris()).toEqual(before);
  });

  it('an empty query delimiter is normalized away instead of becoming a distinct match target', async () => {
    const res = await addRedirectUri(ownerCookie, 'https://zotac.example.com/empty-query?');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { redirectUri: RedirectUriView };
    expect(body.redirectUri.uri).toBe('https://zotac.example.com/empty-query');
  });

  it('plain HTTP is accepted only for loopback hosts', async () => {
    for (const uri of [
      'http://localhost:3000/callback',
      'http://127.0.0.1:5173/callback',
      'http://[::1]:8080/callback',
    ]) {
      const res = await addRedirectUri(ownerCookie, uri);
      expect(res.status, `expected ${uri} to be accepted`).toBe(201);
      const body = (await res.json()) as { redirectUri: RedirectUriView };
      expect(body.redirectUri.uri).toBe(uri);
    }
  });

  it('an Owner edits a redirect URI, and the old value stops matching', async () => {
    const added = await addRedirectUri(ownerCookie, 'https://zotac.example.com/before');
    const { redirectUri } = (await added.json()) as { redirectUri: RedirectUriView };

    const updated = await updateRedirectUri(ownerCookie, redirectUri.id, 'https://zotac.example.com/after');
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { redirectUri: RedirectUriView };
    expect(body.redirectUri.id).toBe(redirectUri.id);
    expect(body.redirectUri.uri).toBe('https://zotac.example.com/after');
    expect(body.redirectUri.updatedAt).toBeTruthy();

    const uris = await storedUris();
    expect(uris).toContain('https://zotac.example.com/after');
    expect(uris).not.toContain('https://zotac.example.com/before');
  });

  it('an edit to an already-registered URI is refused, and an invalid edit is refused', async () => {
    const first = (await (await addRedirectUri(ownerCookie, 'https://zotac.example.com/first')).json()) as {
      redirectUri: RedirectUriView;
    };
    const second = (await (await addRedirectUri(ownerCookie, 'https://zotac.example.com/second')).json()) as {
      redirectUri: RedirectUriView;
    };

    const duplicate = await updateRedirectUri(ownerCookie, second.redirectUri.id, 'https://zotac.example.com/first');
    expect(duplicate.status).toBe(409);
    expect(await storedUris()).toContain('https://zotac.example.com/second');

    const invalid = await updateRedirectUri(ownerCookie, second.redirectUri.id, 'http://zotac.example.com/nope');
    expect(invalid.status).toBe(400);
    expect(await storedUris()).toContain('https://zotac.example.com/second');

    const missing = await updateRedirectUri(ownerCookie, 'does-not-exist', 'https://zotac.example.com/other');
    expect(missing.status).toBe(404);
    expect(first.redirectUri.uri).toBe('https://zotac.example.com/first');
  });

  it('an Owner removes a redirect URI', async () => {
    const added = (await (await addRedirectUri(ownerCookie, 'https://zotac.example.com/removable')).json()) as {
      redirectUri: RedirectUriView;
    };

    const removed = await removeRedirectUri(ownerCookie, added.redirectUri.id);
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as { redirectUri: RedirectUriView };
    expect(body.redirectUri.uri).toBe('https://zotac.example.com/removable');
    expect(await storedUris()).not.toContain('https://zotac.example.com/removable');

    const again = await removeRedirectUri(ownerCookie, added.redirectUri.id);
    expect(again.status).toBe(404);
  });

  it('redirect URI changes are Owner-governed and Administrator-authenticated', async () => {
    const added = (await (await addRedirectUri(ownerCookie, 'https://zotac.example.com/member-proof')).json()) as {
      redirectUri: RedirectUriView;
    };

    const memberRead = await instance.request(`/api/applications/${applicationId}`, {
      headers: { cookie: memberCookie },
    });
    expect(memberRead.status).toBe(200);

    const memberAdd = await addRedirectUri(memberCookie, 'https://zotac.example.com/member-add');
    expect(memberAdd.status).toBe(403);
    const memberUpdate = await updateRedirectUri(
      memberCookie,
      added.redirectUri.id,
      'https://zotac.example.com/member-edit',
    );
    expect(memberUpdate.status).toBe(403);
    const memberRemove = await removeRedirectUri(memberCookie, added.redirectUri.id);
    expect(memberRemove.status).toBe(403);

    const anonymous = await instance.request(`/api/applications/${applicationId}/redirect-uris`, {
      method: 'POST',
      body: { uri: 'https://zotac.example.com/anonymous' },
    });
    expect(anonymous.status).toBe(401);

    expect(await storedUris()).toContain('https://zotac.example.com/member-proof');
  });

  it('a redirect URI cannot be configured for an Application that does not exist', async () => {
    const res = await instance.request('/api/applications/does-not-exist/redirect-uris', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: 'https://zotac.example.com/orphan' },
    });
    expect(res.status).toBe(404);
  });

  it('every change is a first-class audit event naming who changed what, when', async () => {
    const added = (await (await addRedirectUri(ownerCookie, 'https://zotac.example.com/audited')).json()) as {
      redirectUri: RedirectUriView;
    };
    const updated = (await (
      await updateRedirectUri(ownerCookie, added.redirectUri.id, 'https://zotac.example.com/audited-v2')
    ).json()) as { redirectUri: RedirectUriView };
    const removed = await removeRedirectUri(ownerCookie, updated.redirectUri.id);
    expect(removed.status).toBe(200);

    const events = await auditEvents();

    const addedEvent = events.find(
      (event) =>
        event.kind === 'redirect_uri.added' && event.detail.uriId === added.redirectUri.id,
    );
    expect(addedEvent).toBeDefined();
    expect(addedEvent!.actor).toBe(ownerId);
    expect(addedEvent!.detail).toMatchObject({
      applicationId,
      uri: 'https://zotac.example.com/audited',
    });
    expect(Number.isNaN(Date.parse(addedEvent!.occurredAt))).toBe(false);

    const updatedEvent = events.find(
      (event) =>
        event.kind === 'redirect_uri.updated' && event.detail.uriId === added.redirectUri.id,
    );
    expect(updatedEvent).toBeDefined();
    expect(updatedEvent!.actor).toBe(ownerId);
    expect(updatedEvent!.detail).toMatchObject({
      applicationId,
      uri: 'https://zotac.example.com/audited-v2',
      previousUri: 'https://zotac.example.com/audited',
    });

    const removedEvent = events.find(
      (event) =>
        event.kind === 'redirect_uri.removed' && event.detail.uriId === added.redirectUri.id,
    );
    expect(removedEvent).toBeDefined();
    expect(removedEvent!.actor).toBe(ownerId);
    expect(removedEvent!.detail).toMatchObject({
      applicationId,
      uri: 'https://zotac.example.com/audited-v2',
    });

    // The same surface carries the Application's credential events: redirect
    // URI changes are not a side channel, they are first-class security
    // events beside secret generations and revocations.
    expect(events.some((event) => event.kind === 'application.registered')).toBe(true);
    expect(events.some((event) => event.kind === 'client_secret.generated')).toBe(true);
  });
});
