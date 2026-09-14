import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * The throttle's escalating delay is the test's slow endpoint: a warm-up
 * attempt records it, and every later attempt on the same source and email is
 * held for the base delay — a genuinely in-flight request. Administrator
 * sign-in answers 401 on a fresh Instance, so no Bootstrap Ceremony is needed.
 */
const SLOW_ATTEMPT_ENV = {
  IDENTIK_THROTTLE_AFTER_ATTEMPTS: '0',
  IDENTIK_THROTTLE_BASE_DELAY_MS: '3000',
  IDENTIK_THROTTLE_MAX_DELAY_MS: '3000',
};

const DRAIN_BOUND_MS = 10_000;
const SIGN_IN = { email: 'ahmed@example.com', password: 'not the password' };

function signInAttempt(instance: Instance): Promise<Response> {
  return instance.request('/api/administrators/sign-in', {
    method: 'POST',
    body: SIGN_IN,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ticket 03 — graceful drain. Windows cannot deliver catchable signals to a
 * child process (kill terminates forcefully), so the signal path is covered on
 * platforms that have SIGTERM; CI runs this suite on Linux.
 */
describe.skipIf(process.platform === 'win32')(
  'graceful shutdown drains in-flight requests',
  () => {
    let instance: Instance;

    beforeAll(async () => {
      instance = await Instance.start(BACKEND_DIST, SLOW_ATTEMPT_ENV);
      const warmUp = await signInAttempt(instance);
      expect(warmUp.status).toBe(401);
    });

    afterAll(async () => {
      await instance?.stop();
    });

    it('flips readiness, keeps liveness, completes the in-flight request, and exits within the bound', async () => {
      const inFlight = signInAttempt(instance);
      await sleep(400); // the request is now inside its 3s throttle wait

      const signalledAt = Date.now();
      await instance.terminate();

      let readiness: Response | undefined;
      const readyDeadline = Date.now() + 2_000;
      while (Date.now() < readyDeadline) {
        readiness = await instance.request('/health/ready');
        if (readiness.status === 503) break;
        await sleep(50);
      }
      expect(readiness?.status).toBe(503);
      expect(((await readiness?.json()) as { status: string }).status).toBe('unavailable');
      expect(Date.now() - signalledAt).toBeLessThan(2_000);

      // New work is refused while the drain finishes; the health surfaces stay up.
      const refused = await signInAttempt(instance);
      expect(refused.status).toBe(503);
      const live = await instance.request('/health/live');
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'ok' });

      const completed = await inFlight;
      expect(completed.status).toBe(401);
      const finishedAt = Date.now();

      expect(await instance.waitForExit(15_000)).toBe(0);
      expect(Date.now() - finishedAt).toBeLessThan(5_000);
      expect(finishedAt - signalledAt).toBeLessThan(DRAIN_BOUND_MS);
    });
  },
);
