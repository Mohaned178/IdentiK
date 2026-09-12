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
 * the Instance under test is started with a deliberately aggressive window —
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
const UNKNOWN_EMAIL = 'ghost@example.com';
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

describe('Throttling and audited failed authentication, with no lockout', () => {
  let instance: Instance;
  let ownerCookie: string;
  let clientId: string;
  let clientSecret: string;

  const authorize = (
    query: Record<string, string>,
    init: { method?: string; body?: unknown; cookie?: string } = {},
  ): Promise<Response> =>
    instance.request('/api/oidc/authorize', {
      method: init.method ?? 'GET',
      query,
      body: init.body,
      redirect: 'manual',
      headers: init.cookie ? { cookie: init.cookie } : undefined,
    });

  const attemptSignIn = async (email: string, password: string): Promise<Response> =>
    authorize(
      {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid',
        state: 'throttle-state',
      },
      { method: 'POST', body: { email, password } },
    );

  const timed = async (request: () => Promise<Response>): Promise<{ ms: number; res: Response }> => {
    const start = performance.now();
    const res = await request();
    return { ms: performance.now() - start, res };
  };

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  const failedSignInsFor = (events: AuditEventView[], email: string): AuditEventView[] =>
    events.filter(
      (event) => event.kind === 'identity.sign_in.failed' && event.detail.email === email,
    );

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST, THROTTLE_ENV);

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

    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Zotac', type: 'web' },
    });
    expect(registered.status).toBe(201);
    const body = (await registered.json()) as {
      application: ApplicationView;
      clientSecret: string;
    };
    clientId = body.application.clientId;
    clientSecret = body.clientSecret;
    const redirect = await instance.request(
      `/api/applications/${body.application.id}/redirect-uris`,
      { method: 'POST', headers: { cookie: ownerCookie }, body: { uri: REDIRECT_URI } },
    );
    expect(redirect.status).toBe(201);

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
      const { ms, res } = await timed(() => attemptSignIn(CAMPAIGN_EMAIL, 'the wrong password'));
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
      const { res } = await timed(() => attemptSignIn(END_USER.email, 'the wrong password'));
      expect(res.status).toBe(401);
    }

    const { res } = await timed(() => attemptSignIn(END_USER.email, END_USER.password));
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

  it('throttling does not distinguish an existing email from an unknown one', async () => {
    const existing: number[] = [];
    const unknown: number[] = [];
    let existingResponse = '';
    let unknownResponse = '';
    for (let i = 0; i < 4; i++) {
      const known = await timed(() => attemptSignIn(END_USER.email, 'the wrong password'));
      expect(known.res.status).toBe(401);
      existing.push(known.ms);
      existingResponse = await known.res.text();

      const ghost = await timed(() => attemptSignIn(UNKNOWN_EMAIL, 'the wrong password'));
      expect(ghost.res.status).toBe(401);
      unknown.push(ghost.ms);
      unknownResponse = await ghost.res.text();
    }

    // The submission above is keyed on the email whether or not an Identity
    // owns it, so the delay and the refusal are indistinguishable.
    expect(existingResponse).toBe(unknownResponse);
    expect(Math.abs(median(existing) - median(unknown))).toBeLessThan(250);
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
});
