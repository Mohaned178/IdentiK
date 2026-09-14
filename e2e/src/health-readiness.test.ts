import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';
import { dropDatabase, ensureDatabase } from './provision';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

interface ReadinessView {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: {
    database: { ok: boolean };
    mail: { binding: string; reachable: boolean };
  };
}

interface ReadinessResponse {
  status: number;
  body: ReadinessView;
}

async function readiness(instance: Instance): Promise<ReadinessResponse> {
  const res = await instance.request('/health/ready');
  return { status: res.status, body: (await res.json()) as ReadinessView };
}

async function waitForReadiness(
  instance: Instance,
  predicate: (response: ReadinessResponse) => boolean,
  timeoutMs = 20_000,
): Promise<ReadinessResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: ReadinessResponse | undefined;
  while (Date.now() < deadline) {
    last = await readiness(instance);
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`readiness never matched; last seen: ${JSON.stringify(last)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ticket 02 — liveness and readiness. Both surfaces are public, carry only
 * coarse booleans, and are observed here exactly as an orchestrator would use
 * them: liveness for the process, readiness for the database, with the mail
 * relay reported but never gating.
 */
describe('liveness and readiness', () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('reports liveness while the process serves', async () => {
    const res = await instance.request('/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness as database and mail checks only', async () => {
    const { status, body } = await readiness(instance);
    expect(status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      checks: { database: { ok: true }, mail: { binding: 'capture', reachable: true } },
    });
  });

  it('keeps /health as the readiness alias', async () => {
    const ready = await readiness(instance);
    const alias = await instance.request('/health');
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(ready.body);
  });

  it('turns unavailable while PostgreSQL is unreachable and recovers when it returns', async () => {
    await dropDatabase(instance.databaseName);
    const down = await waitForReadiness(
      instance,
      ({ status, body }) => status === 503 && body.status === 'unavailable',
    );
    expect(down.body.checks.database).toEqual({ ok: false });

    await ensureDatabase(instance.databaseName);
    const up = await waitForReadiness(
      instance,
      ({ status, body }) => status === 200 && body.status === 'ok',
    );
    expect(up.body.checks.database).toEqual({ ok: true });
  });
});
