import { Injectable } from '@nestjs/common';
import { parseCount, parseTtlMs } from '../config/env';

/**
 * The subject a public authentication request is throttled for: where it came
 * from and which Identity (or Client) it targeted. Either may be absent, and
 * an absent dimension simply does not contribute to the delay.
 */
export interface ThrottleSubject {
  source?: string | null;
  identity?: string | null;
}

/**
 * The anti-abuse posture (ADR-0020): escalating delay, never a lockout. This
 * service holds recent attempt timestamps per key and answers how long a
 * request must be held to slow a credential campaign; it never mutates an
 * Identity's state and no amount of failures ever renders one unusable. The
 * delay is deliberately observable at the HTTP surface — the caller awaits it
 * before responding — rather than exposed through an internal counter.
 *
 * Throttling is scoped per endpoint and applied on two dimensions — the
 * request source and the targeted Identity (or Client, on the token surface
 * where no End-User email exists). The key is the *submitted* email, whether
 * or not an Identity owns it, so the delay never distinguishes email-exists
 * from email-not-exists (ADR-0020): the rate limiter is as uniform as the
 * response it protects.
 *
 * Thresholds are deployment configuration, deliberately left open by the
 * spec. An attempt that proves the credential (`recordSuccess`) clears the
 * targeted principal's history so a legitimate user is never punished for
 * mistyping; the source history is left alone so scanning stays slow.
 */
@Injectable()
export class ThrottleService {
  private readonly attempts = new Map<string, number[]>();

  private readonly windowMs = parseTtlMs('IDENTIK_THROTTLE_WINDOW_MS', 15 * 60 * 1000);
  private readonly freeAttempts = parseCount('IDENTIK_THROTTLE_AFTER_ATTEMPTS', 50);
  private readonly baseDelayMs = parseTtlMs('IDENTIK_THROTTLE_BASE_DELAY_MS', 200);
  private readonly maxDelayMs = parseTtlMs('IDENTIK_THROTTLE_MAX_DELAY_MS', 5000);

  /**
   * The delay this request should incur, without recording it. The larger of
   * the source and Identity delays wins, so an attack from many sources is
   * still slowed per Identity and an attack on many Identities is still
   * slowed per source.
   */
  delayFor(scope: string, subject: ThrottleSubject): number {
    const now = Date.now();
    return Math.max(
      this.delayForKey(this.sourceKey(scope, subject.source), now),
      this.delayForKey(this.identityKey(scope, subject.identity), now),
    );
  }

  /** Hold the request for its current escalation, then return the delay applied. */
  async wait(scope: string, subject: ThrottleSubject): Promise<number> {
    const delay = this.delayFor(scope, subject);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return delay;
  }

  /** Record one attempt (or failure) against both dimensions. */
  record(scope: string, subject: ThrottleSubject): void {
    const now = Date.now();
    for (const key of [
      this.sourceKey(scope, subject.source),
      this.identityKey(scope, subject.identity),
    ]) {
      if (!key) continue;
      const live = this.prune(key, now);
      live.push(now);
      this.attempts.set(key, live);
    }
  }

  /** The targeted principal proved its credential: forget its history. */
  recordSuccess(scope: string, subject: ThrottleSubject): void {
    const key = this.identityKey(scope, subject.identity);
    if (key) this.attempts.delete(key);
  }

  private delayForKey(key: string | null, now: number): number {
    if (!key) return 0;
    const count = this.prune(key, now).length;
    if (count <= this.freeAttempts) return 0;
    // Exponential escalation, capped; the exponent is bounded before the
    // shift so a long campaign can never overflow into a nonsense delay.
    const steps = Math.min(count - this.freeAttempts - 1, 20);
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** steps);
  }

  /** Drop the key's expired timestamps and return its live history. */
  private prune(key: string, now: number): number[] {
    const timestamps = this.attempts.get(key);
    if (!timestamps) return [];
    const live = timestamps.filter((at) => at > now - this.windowMs);
    if (live.length === 0) {
      this.attempts.delete(key);
      return [];
    }
    this.attempts.set(key, live);
    return live;
  }

  private sourceKey(scope: string, source: string | null | undefined): string | null {
    return source ? `${scope}:source:${source}` : null;
  }

  private identityKey(scope: string, identity: string | null | undefined): string | null {
    return identity ? `${scope}:identity:${identity}` : null;
  }
}
