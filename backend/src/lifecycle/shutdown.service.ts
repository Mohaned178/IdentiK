import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * The topology decision's bound: how long a shutdown waits for in-flight
 * requests before closing the app.
 */
export const DRAIN_BOUND_MS = 10_000;

/** The surfaces that keep answering while the Instance drains. */
const HEALTH_PATHS = new Set(['/health', '/health/live', '/health/ready']);

/**
 * The Instance's shutdown state (the locked single-process topology): one
 * process, one drain. Readiness consults `isDraining()` so it flips the moment
 * a termination signal arrives, and the Express middleware refuses new work
 * and counts in-flight requests so the drain knows when the work has finished.
 */
@Injectable()
export class ShutdownService {
  private draining = false;
  private active = 0;

  /** Readiness's verdict from the moment shutdown begins. */
  isDraining(): boolean {
    return this.draining;
  }

  /** The first termination signal begins the one drain; later signals return false. */
  beginDrain(): boolean {
    if (this.draining) return false;
    this.draining = true;
    return true;
  }

  activeRequests(): number {
    return this.active;
  }

  /**
   * Registered before the Instance accepts traffic, so no request escapes the
   * count. Once draining, new work is refused — only the health surfaces keep
   * answering — while requests already in flight each release their slot
   * exactly once, on finish or on abort.
   */
  trackRequest = (req: Request, res: Response, next: NextFunction): void => {
    if (this.draining && !HEALTH_PATHS.has(req.path)) {
      res.status(503).json({ error: 'shutting_down' });
      return;
    }
    this.active += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
