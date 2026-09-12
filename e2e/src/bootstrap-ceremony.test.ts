import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 02 — Bootstrap Ceremony. First boot of a fresh Instance establishes
 * the default Organization and its first Owner via a one-time, expiring,
 * console-initiated ceremony. All observation happens through Seam 1 (the
 * HTTP surface, including the console-revealed token) — never storage.
 */

interface AdministratorSessionResponse {
  administratorId: string;
  organizationName: string;
  role: string;
}

async function completeCeremony(
  instance: Instance,
  token: string,
  body: Record<string, string>,
): Promise<Response> {
  return instance.request(`/api/setup?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    body,
  });
}

async function signIn(
  instance: Instance,
  body: { email: string; password: string },
): Promise<Response> {
  const res = await instance.request('/api/administrators/sign-in', {
    method: 'POST',
    body,
  });
  return res;
}

async function extractCookie(res: Response): Promise<string> {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

describe('Bootstrap Ceremony', () => {
  let instance: Instance;
  let bootstrapToken: string;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('a fresh Instance announces the one-time setup on the console, initiated from the install process', async () => {
    const log = instance.consoleLog();
    const match = [...log.matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1);
    expect(match).toBeDefined();
    bootstrapToken = match![1];
    expect(bootstrapToken.length).toBeGreaterThanOrEqual(20);
  });

  it('the setup status is observable before completion', async () => {
    const res = await instance.request('/api/setup/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean; available: boolean };
    expect(body.completed).toBe(false);
    expect(body.available).toBe(true);
  });

  it('completing the ceremony with a wrong token is refused', async () => {
    const res = await completeCeremony(instance, 'definitely-wrong-token', {
      organizationName: 'Acme',
      email: 'ahmed@example.com',
      password: 'correct horse battery staple',
      name: 'Ahmed',
    });
    expect(res.status).toBe(403);
  });

  it('completing the ceremony without a token is refused', async () => {
    const res = await instance.request('/api/setup', {
      method: 'POST',
      body: {
        organizationName: 'Acme',
        email: 'ahmed@example.com',
        password: 'correct horse battery staple',
        name: 'Ahmed',
      },
    });
    expect(res.status).toBe(403);
  });

  it('completing the ceremony creates the default Organization and the first Owner', async () => {
    const res = await completeCeremony(instance, bootstrapToken, {
      organizationName: 'Acme',
      email: 'ahmed@example.com',
      password: 'correct horse battery staple',
      name: 'Ahmed',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { administratorId: string; organizationName: string };
    expect(body.administratorId).toBeTruthy();
    expect(body.organizationName).toBe('Acme');
  });

  it('the completed ceremony cannot be re-run; second visit is refused', async () => {
    const status = await instance.request('/api/setup/status');
    const statusBody = (await status.json()) as { completed: boolean; available: boolean };
    expect(statusBody.completed).toBe(true);
    expect(statusBody.available).toBe(false);

    const res = await completeCeremony(instance, bootstrapToken, {
      organizationName: 'Mallory Inc',
      email: 'mallory@example.com',
      password: 'evil password 123',
      name: 'Mallory',
    });
    expect(res.status).toBe(409);
  });

  it('the Owner signs in via the dedicated Administrator sign-in and receives an Administrator session', async () => {
    const res = await signIn(instance, { email: 'ahmed@example.com', password: 'correct horse battery staple' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdministratorSessionResponse;
    expect(body.organizationName).toBe('Acme');
    expect(body.role).toBe('owner');
  });

  it('a wrong password is refused uniformly with 401', async () => {
    const res = await signIn(instance, { email: 'ahmed@example.com', password: 'wrong password' });
    expect(res.status).toBe(401);
  });

  it('sign-in with an unknown email is refused identically (no enumeration)', async () => {
    const known = await signIn(instance, { email: 'ahmed@example.com', password: 'wrong password' });
    const unknown = await signIn(instance, { email: 'ghost@example.com', password: 'wrong password' });
    expect(unknown.status).toBe(known.status);
  });

  it('the dashboard shell requires an Administrator session', async () => {
    const res = await instance.request('/api/organization');
    expect(res.status).toBe(401);
  });

  it('the Owner sees their Organization through the Management API', async () => {
    const signInRes = await signIn(instance, { email: 'ahmed@example.com', password: 'correct horse battery staple' });
    const cookie = await extractCookie(signInRes);

    const res = await instance.request('/api/organization', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('Acme');
  });

  it('the audit store records the completed bootstrap', async () => {
    const signInRes = await signIn(instance, { email: 'ahmed@example.com', password: 'correct horse battery staple' });
    const cookie = await extractCookie(signInRes);

    const res = await instance.request('/api/audit', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    const bootstrapEvents = body.events.filter((e) => e.kind === 'bootstrap.completed');
    expect(bootstrapEvents.length).toBe(1);
  });

  it('sign-out revokes the Administrator session', async () => {
    const signInRes = await signIn(instance, { email: 'ahmed@example.com', password: 'correct horse battery staple' });
    const cookie = await extractCookie(signInRes);

    const out = await instance.request('/api/administrators/sign-out', {
      method: 'POST',
      headers: { cookie },
    });
    expect(out.status).toBe(204);

    const after = await instance.request('/api/organization', { headers: { cookie } });
    expect(after.status).toBe(401);
  });
});

describe('Bootstrap Ceremony expiry', () => {
  it('an untouched Instance past its expiry window cannot be claimed, enforced without an Administrator existing', async () => {
    const instance = await Instance.start(BACKEND_DIST, {
      IDENTIK_SETUP_TOKEN_TTL_MS: '500',
    });
    try {
      const log = instance.consoleLog();
      const match = [...log.matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1);
      expect(match).toBeDefined();
      const token = match![1];

      await new Promise((resolve) => setTimeout(resolve, 700));

      const status = await instance.request('/api/setup/status');
      const statusBody = (await status.json()) as { completed: boolean; available: boolean };
      expect(statusBody.available).toBe(false);

      const res = await completeCeremony(instance, token, {
        organizationName: 'Evil Corp',
        email: 'evil@example.com',
        password: 'evil password 123',
        name: 'Evil',
      });
      expect(res.status).toBe(403);
    } finally {
      await instance.stop();
    }
  });

  it('a restart within the window keeps the armed ceremony running down — no fresh token is minted', async () => {
    const stateDir = join(tmpdir(), `identik-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Five seconds, not 1.5: the restart cycle must complete well inside the
    // window even on a loaded CI machine, or the test measures startup time.
    const first = await Instance.startAt(BACKEND_DIST, stateDir, {
      IDENTIK_SETUP_TOKEN_TTL_MS: '5000',
    });
    try {
      const firstLog = first.consoleLog();
      expect([...firstLog.matchAll(/setup token: ([A-Za-z0-9_-]+)/g)]).toHaveLength(1);

      await first.stop({ keepState: true });
      const second = await Instance.startAt(BACKEND_DIST, stateDir, {
        IDENTIK_SETUP_TOKEN_TTL_MS: '5000',
      });
      try {
        const secondLog = second.consoleLog();
        const tokens = [...secondLog.matchAll(/setup token: ([A-Za-z0-9_-]+)/g)];
        expect(tokens).toHaveLength(0);

        const status = await second.request('/api/setup/status');
        const body = (await status.json()) as { completed: boolean; available: boolean };
        expect(body.available).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 5100));
        const after = await second.request('/api/setup/status');
        const afterBody = (await after.json()) as { completed: boolean; available: boolean };
        expect(afterBody.available).toBe(false);
      } finally {
        await second.stop();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('Bootstrap Ceremony concurrency', () => {
  it('two simultaneous completions produce exactly one Organization and one Owner', async () => {
    const instance = await Instance.start(BACKEND_DIST);
    try {
      const log = instance.consoleLog();
      const match = [...log.matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1);
      expect(match).toBeDefined();
      const token = match![1];

      const contenders = [
        {
          organizationName: 'First Corp',
          email: 'first@example.com',
          password: 'first password 123',
          name: 'First',
        },
        {
          organizationName: 'Second Corp',
          email: 'second@example.com',
          password: 'second password 123',
          name: 'Second',
        },
      ];
      const responses = await Promise.all(
        contenders.map((body) => completeCeremony(instance, token, body)),
      );

      expect(responses.map((res) => res.status).sort((a, b) => a - b)).toEqual([201, 409]);

      const winnerIndex = responses.findIndex((res) => res.status === 201);
      const winner = contenders[winnerIndex];
      const loser = contenders[winnerIndex === 0 ? 1 : 0];

      const winnerSignIn = await signIn(instance, {
        email: winner.email,
        password: winner.password,
      });
      expect(winnerSignIn.status).toBe(200);

      const loserSignIn = await signIn(instance, {
        email: loser.email,
        password: loser.password,
      });
      expect(loserSignIn.status).toBe(401);
    } finally {
      await instance.stop();
    }
  });
});

describe('Bootstrap Ceremony Owner email normalization', () => {
  it('folds a non-ASCII email so the Owner signs in with any case', async () => {
    // The sign-in lookup normalizes the submitted email (Unicode-aware
    // toLowerCase), so the ceremony must store the same normalized handle:
    // SQLite's NOCASE collation folds ASCII only.
    const instance = await Instance.start(BACKEND_DIST);
    try {
      const ceremony = await completeCeremony(instance, instance.setupToken(), {
        organizationName: 'Acme',
        email: 'Ähmed@Example.com',
        password: 'owner password 123',
        name: 'Ahmed',
      });
      expect(ceremony.status).toBe(201);

      const signedIn = await signIn(instance, {
        email: 'ähmed@example.com',
        password: 'owner password 123',
      });
      expect(signedIn.status).toBe(200);

      const exactCase = await signIn(instance, {
        email: 'Ähmed@Example.com',
        password: 'owner password 123',
      });
      expect(exactCase.status).toBe(200);
    } finally {
      await instance.stop();
    }
  });
});
