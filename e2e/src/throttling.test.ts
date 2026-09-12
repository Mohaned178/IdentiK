import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 17 — Throttling + audited failed authentication, with no lockout ever
 * (ADR-0020). The anti-abuse posture is observed only through Seam 1 (HTTP):
 * public authentication endpoints answer with an escalating delay as failures
 * accumulate, failed attempts land in the unified audit surface carrying their
 * source and targeted Identity, and no number of failures ever renders an
 * Identity unusable — the correct credential still signs in afterwards.
 *
 * The thresholds are deployment configuration (the spec leaves them open), so
 * the Instances under test are started with a deliberately aggressive window —
 * two free attempts, then an exponential delay capped at 1.5s — to make the
 * escalation observable without a long-running attack.
 */

const THROTTLE_ENV = {
  IDENTIK_THROTTLE_WINDOW_MS: '60000',
  IDENTIK_THROTTLE_AFTER_ATTEMPTS: '2',
  IDENTIK_THROTTLE_BASE_DELAY_MS: '150',
  IDENTIK_THROTTLE_MAX_DELAY_MS: '1500',
};

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const CAMPAIGN_EMAIL = 'campaign@example.com';
const REDIRECT_URI = 'https://zotac.example.com/oidc/callback';

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface ApplicationView {
  id: string;
  clientId: string;
}

function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in email body');
  return match[0];
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Start an Instance and run the Bootstrap Ceremony so an Organization exists. */
async function bootstrap(): Promise<Instance> {
  const instance = await Instance.start(BACKEND_DIST, THROTTLE_ENV);
  const match = [...instance.consoleLog().matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1);
  if (!match) throw new Error('no setup token in console output');
  const ceremony = await instance.request('/api/setup', {
    method: 'POST',
    query: { token: match[1] },
    body: { organizationName: ORGANIZATION_NAME, ...OWNER },
  });
  if (ceremony.status !== 201) throw new Error(`setup failed: ${ceremony.status}`);
  return instance;
}

async function signInOwner(instance: Instance): Promise<string> {
  const res = await instance.request('/api/administrators/sign-in', {
    method: 'POST',
    body: { email: OWNER.email, password: OWNER.password },
  });
  if (res.status !== 200) throw new Error(`owner sign-in failed: ${res.status}`);
  return cookieFrom(res);
}

async function registerWebApp(
  instance: Instance,
  ownerCookie: string,
): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const registered = await instance.request('/api/applications', {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: { name: 'Zotac', type: 'web' },
  });
  if (registered.status !== 201) throw new Error(`registration failed: ${registered.status}`);
  const body = (await registered.json()) as {
    application: ApplicationView;
    clientSecret: string;
  };
  const redirect = await instance.request(`/api/applications/${body.application.id}/redirect-uris`, {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: { uri: REDIRECT_URI },
  });
  if (redirect.status !== 201) throw new Error(`redirect URI failed: ${redirect.status}`);
  return { id: body.application.id, clientId: body.application.clientId, clientSecret: body.clientSecret };
}

/** Sign in on the hosted page, as the page's form would. */
function attemptSignIn(
  instance: Instance,
  clientId: string,
  email: string,
  password: string,
): Promise<Response> {
  return instance.request('/api/oidc/authorize', {
    method: 'POST',
    query: {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      state: 'throttle-state',
    },
    body: { email, password },
    redirect: 'manual',
  });
}

async function timed(request: () => Promise<Response>): Promise<{ ms: number; res: Response }> {
  const start = performance.now();
  const res = await request();
  return { ms: performance.now() - start, res };
}

function failedSignInsFor(events: AuditEventView[], email: string): AuditEventView[] {
  return events.filter(
    (event) => event.kind === 'identity.sign_in.failed' && event.detail.email === email,
  );
}

describe('Throttling and audited failed authentication, with no lockout', () => {
  let instance: Instance;
  let ownerCookie: string;
  let clientId: string;
  let clientSecret: string;

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  beforeAll(async () => {
    instance = await bootstrap();
    ownerCookie = await signInOwner(instance);
    const application = await registerWebApp(instance, ownerCookie);
    clientId = application.clientId;
    clientSecret = application.clientSecret;

    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: END_USER,
    });
    expect(signUp.status).toBe(201);
    const mail = (await instance.capturedEmails()).find(
      (email) => email.to === END_USER.email && /verify/i.test(email.subject),
    );
    const verified = await fetch(linkFromBody(mail!.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('a sustained credential campaign is delayed at the HTTP surface', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 8; i++) {
      const { ms, res } = await timed(() =>
        attemptSignIn(instance, clientId, CAMPAIGN_EMAIL, 'the wrong password'),
      );
      expect(res.status).toBe(401);
      durations.push(ms);
    }

    // The first attempts are free; by the eighth the delay is at the cap. The
    // rise is far larger than localhost noise, so it is asserted as a trend
    // rather than an exact curve.
    expect(durations[7]!).toBeGreaterThan(durations[0]! + 500);
    expect(durations[5]!).toBeGreaterThan(durations[2]! + 100);
  });

  it('never locks the Identity out — the correct credential still signs in after sustained failures', async () => {
    for (let i = 0; i < 6; i++) {
      const { res } = await timed(() =>
        attemptSignIn(instance, clientId, END_USER.email, 'the wrong password'),
      );
      expect(res.status).toBe(401);
    }

    const { res } = await timed(() =>
      attemptSignIn(instance, clientId, END_USER.email, END_USER.password),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBeTruthy();
    expect(new URL(location!).searchParams.get('code')).toBeTruthy();
    expect(res.headers.get('set-cookie')).toMatch(/^identik_sso_session=/);
  });

  it('a scripted campaign is visible as a sequence of audit events with source and Identity', async () => {
    const campaign = failedSignInsFor(await auditEvents(), CAMPAIGN_EMAIL);
    expect(campaign).toHaveLength(8);
    for (const event of campaign) {
      expect(event.detail.source, event.id).toBeTruthy();
      expect(event.detail.email).toBe(CAMPAIGN_EMAIL);
    }

    // Newest-first is the surface's contract: the eight failures read as one
    // ordered campaign.
    const times = campaign.map((event) => new Date(event.occurredAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const targeted = failedSignInsFor(await auditEvents(), END_USER.email);
    expect(targeted.length).toBeGreaterThanOrEqual(6);
    for (const event of targeted) expect(event.detail.source).toBeTruthy();
  });

  it('sign-up applies the same escalating delay', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { ms, res } = await timed(() =>
        instance.request('/api/end-users/sign-up', {
          method: 'POST',
          body: { email: `throttle-signup-${i}@example.com`, password: 'a password 123' },
        }),
      );
      expect(res.status).toBe(201);
      durations.push(ms);
    }
    expect(durations[6]!).toBeGreaterThan(durations[0]! + 500);
  });

  it('forgot-password applies the same escalating delay', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { ms, res } = await timed(() =>
        instance.request('/api/end-users/forgot-password', {
          method: 'POST',
          body: { email: `throttle-forgot-${i}@example.com` },
        }),
      );
      expect(res.status).toBe(202);
      durations.push(ms);
    }
    expect(durations[6]!).toBeGreaterThan(durations[0]! + 500);
  });

  it('token exchange applies the same escalating delay to failed grants', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { ms, res } = await timed(() =>
        instance.request('/api/oidc/token', {
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'not-a-real-authorization-code',
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            client_secret: clientSecret,
          },
        }),
      );
      expect(res.status).toBe(400);
      durations.push(ms);
    }
    expect(durations[6]!).toBeGreaterThan(durations[0]! + 500);
  });

  it('administrator sign-in applies the same escalating delay', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { ms, res } = await timed(() =>
        instance.request('/api/administrators/sign-in', {
          method: 'POST',
          body: { email: 'unknown-admin@example.com', password: 'the wrong password' },
        }),
      );
      expect(res.status).toBe(401);
      durations.push(ms);
    }
    expect(durations[6]!).toBeGreaterThan(durations[0]! + 500);
  });
});

/**
 * The uniformity proof ADR-0020 asks for cannot be read off one Instance: once
 * a source is saturated, both an existing and an unknown email are delayed by
 * the source key, which hides whether the Identity key is behaving uniformly.
 * So the same submitted email is attacked against two fresh Instances — one
 * where it owns a verified Identity, one where it owns nothing — and the two
 * escalation curves must match.
 */
describe('Throttling uniformity across email existence', () => {
  const TARGET_EMAIL = 'member@example.com';
  let existingInstance: Instance;
  let absentInstance: Instance;
  let existingClientId: string;
  let absentClientId: string;

  beforeAll(async () => {
    existingInstance = await bootstrap();
    absentInstance = await bootstrap();
    const existingOwner = await signInOwner(existingInstance);
    const absentOwner = await signInOwner(absentInstance);
    existingClientId = (await registerWebApp(existingInstance, existingOwner)).clientId;
    absentClientId = (await registerWebApp(absentInstance, absentOwner)).clientId;

    // The email owns a verified Identity in one Instance only.
    const signUp = await existingInstance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: { email: TARGET_EMAIL, password: 'member password 123' },
    });
    expect(signUp.status).toBe(201);
    const mail = (await existingInstance.capturedEmails()).find(
      (email) => email.to === TARGET_EMAIL && /verify/i.test(email.subject),
    );
    const verified = await fetch(linkFromBody(mail!.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);
  });

  afterAll(async () => {
    await existingInstance.stop();
    await absentInstance.stop();
  });

  it('throttles and refuses an existing email exactly like an unknown one', async () => {
    const existing: number[] = [];
    const absent: number[] = [];
    let existingBody = '';
    let absentBody = '';
    for (let i = 0; i < 6; i++) {
      const known = await timed(() =>
        attemptSignIn(existingInstance, existingClientId, TARGET_EMAIL, 'the wrong password'),
      );
      expect(known.res.status).toBe(401);
      existing.push(known.ms);
      existingBody = await known.res.text();

      const unknown = await timed(() =>
        attemptSignIn(absentInstance, absentClientId, TARGET_EMAIL, 'the wrong password'),
      );
      expect(unknown.res.status).toBe(401);
      absent.push(unknown.ms);
      absentBody = await unknown.res.text();
    }

    // Both start from a fresh source and Identity, so both escalate; the
    // refusal shape is identical; and the curves match within noise. The delay
    // is keyed on the submitted string, never on whether an Identity owns it.
    expect(existingBody).toBe(absentBody);
    expect(existing[5]!).toBeGreaterThan(existing[0]! + 300);
    expect(absent[5]!).toBeGreaterThan(absent[0]! + 300);
    expect(Math.abs(median(existing) - median(absent))).toBeLessThan(300);
  });
});
