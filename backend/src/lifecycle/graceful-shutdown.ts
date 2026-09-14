import type { INestApplication } from '@nestjs/common';
import { DRAIN_BOUND_MS, ShutdownService } from './shutdown.service';

/** How often the drain re-reads the in-flight count while waiting. */
const POLL_MS = 25;

/**
 * SIGTERM (and SIGINT) begin the drain the topology decision fixed: new work
 * is refused at once, readiness flips unavailable immediately, in-flight
 * requests finish within DRAIN_BOUND_MS, then the app closes — remaining
 * connections are force-closed by the adapter, the data client disconnects —
 * and the process exits. A second signal is ignored; the bound is the exit
 * guarantee.
 *
 * Handlers are installed before the listener resolves, and the drain waits for
 * it, so a signal during boot cannot cut an Instance that has not started
 * serving.
 */
export function installGracefulShutdown(
  app: INestApplication,
  shutdown: ShutdownService,
  listening: Promise<unknown>,
): void {
  const begin = (): void => {
    if (!shutdown.beginDrain()) return;
    drain().catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
  };
  process.on('SIGTERM', begin);
  process.on('SIGINT', begin);

  async function drain(): Promise<void> {
    await listening.catch(() => undefined);
    const deadline = Date.now() + DRAIN_BOUND_MS;
    while (shutdown.activeRequests() > 0 && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    await app.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
