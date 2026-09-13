import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 06 — Application registration and the Client credential lifecycle
 * (ADR-0009, ADR-0010, ADR-0016, ADR-0019). Observed only through Seam 1 (the
 * Management API over HTTP) and the audit surface that sits on it.
 *
 * A Web Application is a confidential client: an Owner registers it and
 * receives its first Client Secret exactly once. Secrets are stored
 * verifiable-only (no read-back path exists for anyone, including Owners),
 * multiple labeled secrets coexist, and each can be revoked individually so
 * rotation is zero-downtime. A SPA/Mobile Application is a public client and
 * is never issued a Client Secret — not at registration, not through any
 * later API path. The dashboard is a client of this same API.
 *
 * The one capability the ticket names that does not yet exist at this seam is
 * a client *authenticating* with a secret: that requires the token endpoint,
 * which arrives in ticket 10. Until then the observable invariant is that
 * concurrent secrets are both live and revoking one leaves the other live.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'layla chosen password 123', name: 'Layla' };

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface SecretView {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

interface ApplicationView {
  id: string;
  name: string;
  type: 'web' | 'spa';
  clientId: string;
  createdAt: string;
  secrets: SecretView[];
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

describe('Application registration and Client credential lifecycle', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;

  const registerApplication = (
    cookie: string,
    body: { name: string; type: 'web' | 'spa' },
  ): Promise<Response> =>
    instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie },
      body,
    });

  const listApplications = async (cookie: string): Promise<ApplicationView[]> => {
    const res = await instance.request('/api/applications', { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { applications: ApplicationView[] }).applications;
  };

  const getApplication = async (cookie: string, id: string): Promise<ApplicationView> => {
    const res = await instance.request(`/api/applications/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { application: ApplicationView }).application;
  };

  const generateSecret = (
    cookie: string,
    id: string,
    body: { label: string },
  ): Promise<Response> =>
    instance.request(`/api/applications/${id}/secrets`, {
      method: 'POST',
      headers: { cookie },
      body,
    });

  const revokeSecret = (cookie: string, id: string, secretId: string): Promise<Response> =>
    instance.request(`/api/applications/${id}/secrets/${secretId}/revoke`, {
      method: 'POST',
      headers: { cookie },
    });

  const auditEvents = async (cookie: string): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie } });
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
    ownerCookie = cookieFrom(owner);

    const invited = await instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { email: MEMBER.email, role: 'member' },
    });
    expect(invited.status).toBe(201);
    const mails = (await instance.capturedEmails()).filter(
      (mail) => mail.to === MEMBER.email && /invit/i.test(mail.subject),
    );
    const token = tokenFromLink(linkFromBody(mails.at(-1)!.body));
    const accepted = await instance.request('/api/administrators/invitations/accept', {
      method: 'POST',
      body: { token, ...MEMBER },
    });
    expect(accepted.status).toBe(201);

    const member = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: MEMBER.email, password: MEMBER.password },
    });
    memberCookie = cookieFrom(member);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('an Owner registers a Web Application with a name and type', async () => {
    const res = await registerApplication(ownerCookie, { name: 'Zotac', type: 'web' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application: ApplicationView; clientSecret: string };
    expect(body.application.name).toBe('Zotac');
    expect(body.application.type).toBe('web');
    expect(typeof body.application.clientId).toBe('string');
    expect(body.application.clientId.length).toBeGreaterThan(0);
  });

  it('the Client ID is public, permanent, and never rotated', async () => {
    const created = (await (
      await registerApplication(ownerCookie, { name: 'CodeBoard', type: 'web' })
    ).json()) as { application: ApplicationView };
    const clientId = created.application.clientId;

    const listed = (await listApplications(ownerCookie)).find(
      (app) => app.id === created.application.id,
    );
    expect(listed?.clientId).toBe(clientId);

    const fetched = await getApplication(ownerCookie, created.application.id);
    expect(fetched.clientId).toBe(clientId);

    // There is no rotation surface: registering again mints a distinct ID,
    // and nothing in the lifecycle changes an existing one.
    const another = (await (
      await registerApplication(ownerCookie, { name: 'Another', type: 'web' })
    ).json()) as { application: ApplicationView };
    expect(another.application.clientId).not.toBe(clientId);
    expect((await getApplication(ownerCookie, created.application.id)).clientId).toBe(clientId);
  });

  it('a Web Application receives a Client Secret displayed exactly once at generation', async () => {
    const res = await registerApplication(ownerCookie, { name: 'Shown Once', type: 'web' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application: ApplicationView; clientSecret: string | null };
    expect(typeof body.clientSecret).toBe('string');
    expect(body.clientSecret!.length).toBeGreaterThan(0);

    // The secret is not part of the returned credential metadata, and the
    // generated metadata carries a label and a creation timestamp.
    const secret = body.application.secrets[0]!;
    expect(secret.label.length).toBeGreaterThan(0);
    expect(secret.createdAt).toBeTruthy();
    expect(secret.revokedAt).toBeNull();
    expect((secret as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect(JSON.stringify(body.application)).not.toContain(body.clientSecret!);
  });

  it('the secret cannot be viewed again through any read path, even by an Owner', async () => {
    const created = (await (
      await registerApplication(ownerCookie, { name: 'No Read Back', type: 'web' })
    ).json()) as { application: ApplicationView; clientSecret: string };
    const secretValue = created.clientSecret;

    const detail = await getApplication(ownerCookie, created.application.id);
    expect(JSON.stringify(detail)).not.toContain(secretValue);

    const listed = await listApplications(ownerCookie);
    expect(JSON.stringify(listed)).not.toContain(secretValue);
  });

  it('multiple concurrent labeled secrets coexist and are revoked individually', async () => {
    const created = (await (
      await registerApplication(ownerCookie, { name: 'Rotation', type: 'web' })
    ).json()) as { application: ApplicationView; clientSecret: string };
    const appId = created.application.id;
    const firstSecretId = created.application.secrets[0]!.id;
    const firstLabel = created.application.secrets[0]!.label;

    const second = await generateSecret(ownerCookie, appId, { label: 'rotation-2026' });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { secret: SecretView; clientSecret: string };
    expect(secondBody.secret.label).toBe('rotation-2026');
    expect(typeof secondBody.clientSecret).toBe('string');
    expect(secondBody.clientSecret).not.toBe(created.clientSecret);

    const both = await getApplication(ownerCookie, appId);
    const active = both.secrets.filter((secret) => secret.revokedAt === null);
    expect(active).toHaveLength(2);
    expect(active.map((secret) => secret.label).sort()).toEqual(
      [firstLabel, 'rotation-2026'].sort(),
    );

    const revoked = await revokeSecret(ownerCookie, appId, firstSecretId);
    expect(revoked.status).toBe(200);

    const after = await getApplication(ownerCookie, appId);
    const stillActive = after.secrets.filter((secret) => secret.revokedAt === null);
    expect(stillActive).toHaveLength(1);
    expect(stillActive[0]!.id).toBe(secondBody.secret.id);

    const revokedView = after.secrets.find((secret) => secret.id === firstSecretId);
    expect(revokedView?.revokedAt).toBeTruthy();
  });

  it('a SPA/Mobile Application is never issued a Client Secret, at registration or later', async () => {
    const res = await registerApplication(ownerCookie, { name: 'Mobile App', type: 'spa' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      application: ApplicationView;
      clientSecret: string | null;
    };
    expect(body.clientSecret ?? null).toBeNull();
    expect(body.application.secrets).toHaveLength(0);

    const generate = await generateSecret(ownerCookie, body.application.id, { label: 'never' });
    expect(generate.status).toBe(400);
    expect(((await generate.json()) as { message: string }).message).toMatch(/never issued/i);

    const detail = await getApplication(ownerCookie, body.application.id);
    expect(detail.secrets).toHaveLength(0);
  });

  it('a Member may register a SPA/Mobile Application but not a Web Application', async () => {
    const spa = await registerApplication(memberCookie, { name: 'Member SPA', type: 'spa' });
    expect(spa.status).toBe(201);

    const web = await registerApplication(memberCookie, { name: 'Member Web', type: 'web' });
    expect(web.status).toBe(403);
  });

  it('secret generation and revocation are Owner-only at the Management API', async () => {
    const created = (await (
      await registerApplication(ownerCookie, { name: 'Owner Only', type: 'web' })
    ).json()) as { application: ApplicationView };
    const appId = created.application.id;

    const generated = await generateSecret(memberCookie, appId, { label: 'member tries' });
    expect(generated.status).toBe(403);

    const revoke = await revokeSecret(
      memberCookie,
      appId,
      created.application.secrets[0]!.id,
    );
    expect(revoke.status).toBe(403);
  });

  it('registration, credential generation, and revocation are audit events', async () => {
    const created = (await (
      await registerApplication(ownerCookie, { name: 'Audited', type: 'web' })
    ).json()) as { application: ApplicationView };
    const appId = created.application.id;

    const generated = (await (
      await generateSecret(ownerCookie, appId, { label: 'audited-secret' })
    ).json()) as { secret: SecretView };

    const revoke = await revokeSecret(ownerCookie, appId, generated.secret.id);
    expect(revoke.status).toBe(200);

    const events = await auditEvents(ownerCookie);

    const registered = events.filter(
      (event) =>
        event.kind === 'application.registered' && event.detail.applicationId === appId,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]!.detail).toMatchObject({ name: 'Audited', type: 'web' });

    const issued = events.filter(
      (event) =>
        event.kind === 'client_secret.generated' &&
        event.detail.secretId === generated.secret.id,
    );
    expect(issued).toHaveLength(1);
    expect(issued[0]!.detail).toMatchObject({ applicationId: appId, label: 'audited-secret' });

    const revoked = events.filter(
      (event) =>
        event.kind === 'client_secret.revoked' && event.detail.secretId === generated.secret.id,
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.detail).toMatchObject({ applicationId: appId, label: 'audited-secret' });
  });

  it('the Management API is Administrator-only and Organization-scoped', async () => {
    const anonymous = await instance.request('/api/applications');
    expect(anonymous.status).toBe(401);

    const missing = await instance.request('/api/applications/does-not-exist', {
      headers: { cookie: ownerCookie },
    });
    expect(missing.status).toBe(404);
  });
});
