import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const SPOOFED_IP = '203.0.113.7';

interface AuditEventView {
  kind: string;
  detail: Record<string, unknown>;
}

interface SessionCookie {
  /** The `name=value` pair a client sends back. */
  value: string;
  /** The raw Set-Cookie header, attributes included. */
  raw: string;
}

/** Complete the Bootstrap Ceremony and return the Owner's session cookie. */
async function completeCeremony(instance: Instance): Promise<SessionCookie> {
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
  const raw = signIn.headers.get('set-cookie') ?? '';
  return { value: raw.split(';')[0] ?? '', raw };
}

/** Fail an Administrator sign-in carrying a forwarded header, then read the audited source. */
async function auditedSource(
  instance: Instance,
  ownerCookie: string,
  forwardedFor: string,
): Promise<unknown> {
  const failed = await instance.request('/api/administrators/sign-in', {
    method: 'POST',
    headers: { 'x-forwarded-for': forwardedFor },
    body: { email: 'ghost-admin@example.com', password: 'the wrong password' },
  });
  expect(failed.status).toBe(401);

  const audit = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
  expect(audit.status).toBe(200);
  const events = ((await audit.json()) as { events: AuditEventView[] }).events;
  const failure = events.find(
    (event) =>
      event.kind === 'administrator.sign_in.failed' &&
      event.detail.email === 'ghost-admin@example.com',
  );
  expect(failure).toBeDefined();
  return failure?.detail.source;
}

async function expectStartupRefusal(env: Record<string, string>, pattern: RegExp): Promise<void> {
  let started: Instance | undefined;
  try {
    started = await Instance.start(BACKEND_DIST, env);
  } catch (error) {
    expect(String(error)).toMatch(pattern);
    return;
  }
  await started.stop();
  throw new Error('expected the Instance to refuse to start, but it served traffic');
}

async function expectBoots(env: Record<string, string>): Promise<void> {
  const instance = await Instance.start(BACKEND_DIST, env);
  try {
    expect((await instance.request('/health')).status).toBe(200);
  } finally {
    await instance.stop();
  }
}

/**
 * Ticket 05 — the network-edge and browser posture. The operator states which
 * proxies are trusted; only then does a forwarded header change the client
 * source that throttling and the audit surface see. Responses carry the
 * baseline headers, HSTS follows the configured public origin, cookies keep
 * their posture, and the Instance never redirects HTTP to HTTPS itself.
 */
describe('edge posture', () => {
  let instance: Instance;
  let owner: SessionCookie;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);
    owner = await completeCeremony(instance);
  });

  afterAll(async () => {
    await instance?.stop();
  });

  it('carries the baseline security headers and suppresses the framework banner', async () => {
    const res = await instance.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('sends HSTS only under an https base URL', async () => {
    const res = await instance.request('/health');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('answers no CORS headers to a cross-origin request', async () => {
    const res = await instance.request('/health', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never redirects HTTP to HTTPS itself', async () => {
    expect((await instance.request('/health', { redirect: 'manual' })).status).toBe(200);
    expect((await instance.request('/', { redirect: 'manual' })).status).toBe(404);
  });

  it('keeps the session cookie host-only, HttpOnly, SameSite=Lax on Path=/, without Secure over HTTP', () => {
    expect(owner.raw).toMatch(/HttpOnly/i);
    expect(owner.raw).toMatch(/SameSite=Lax/i);
    expect(owner.raw).toMatch(/Path=\//);
    expect(owner.raw).not.toMatch(/Domain=/i);
    expect(owner.raw).not.toMatch(/Secure/i);
  });

  it('ignores a forged forwarded header with proxy trust off', async () => {
    const source = await auditedSource(instance, owner.value, SPOOFED_IP);
    expect(String(source)).not.toContain(SPOOFED_IP);
    expect(String(source)).toMatch(/127\.0\.0\.1|::1/);
  });
});

describe('trusted proxy', () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST, { IDENTIK_TRUST_PROXY: 'loopback' });
  });

  afterAll(async () => {
    await instance?.stop();
  });

  it('honors a forwarded header from a trusted proxy for the audited source', async () => {
    const owner = await completeCeremony(instance);
    const source = await auditedSource(instance, owner.value, SPOOFED_IP);
    expect(source).toBe(SPOOFED_IP);
  });
});

describe('https public origin', () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST, {
      // Mixed-case scheme on purpose: the origin's TLS-ness must not depend on casing.
      IDENTIK_BASE_URL: 'HTTPS://Identity.e2e.test',
    });
  });

  afterAll(async () => {
    await instance?.stop();
  });

  it('sends HSTS and marks the session cookie Secure without redirecting plain HTTP', async () => {
    const res = await instance.request('/health', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);

    const owner = await completeCeremony(instance);
    expect(owner.raw).toMatch(/Secure/i);
    expect(owner.raw).toMatch(/SameSite=Lax/i);
    expect(owner.raw).not.toMatch(/Domain=/i);
  });
});

describe('the trust-proxy setting', () => {
  it.each(['1', '10.0.0.0/8,192.168.0.0/16', 'loopback, 10.0.0.0/8'])(
    'accepts %s',
    async (value) => {
      await expectBoots({ IDENTIK_TRUST_PROXY: value });
    },
  );

  it.each(['garbage', 'true', '10.0.0.0/99', '0.0.0.0/0'])('refuses %s', async (value) => {
    await expectStartupRefusal({ IDENTIK_TRUST_PROXY: value }, /IDENTIK_TRUST_PROXY/);
  });
});
