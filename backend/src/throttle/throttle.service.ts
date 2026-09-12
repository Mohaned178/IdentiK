import { Injectable } from '@nestjs/common';
import { parseCount, parseTtlMs } from '../config/env';

/**
 * The public authentication surfaces that carry rate limiting (ADR-0020). One
 * scope per endpoint so throttling an Administrator's sign-in never throttles
 * an End User's.
 */
export type ThrottleScope =
  | 'sign-in'
  | 'administrator-sign-in'
  | 'sign-up'
  | 'forgot-password'
  | 'token';

/**
 * The subject a public authentication request is throttled for: where it came
 * from and which Identity it targeted. Either may be absent, and an absent
 * dimension simply does not contribute to the delay.
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
 * Throttling is scoped per endpoint and applied on two dimensions: the
 * request source and the targeted Identity. The Identity key is the
 * *submitted* email, whether or not an Identity owns it, so the delay never
 * distinguishes email-exists from email-not-exists (ADR-0020): the rate
 * limiter is as uniform as the response it protects. On the token surface,
 * where requests carry no email, the Identity is the one the grant targets.
 *
 * Thresholds are deployment configuration, deliberately left open by the
 * spec. An attempt that proves the credential (`recordSuccess`) clears the
 * targeted Identity's history so an End User is never punished for mistyping;
 * the source history is left alone so scanning stays slow.
 */
@Injectable()
export class ThrottleService {
  private readonly attempts = new Map<string, number[]>();

  private readonly windowMs = parseTtlMs('IDENTIK_THROTTLE_WINDOW_MS', 15 * 60 * 1000);
  private readonly freeAttempts = parseCount('IDENTIK_THROTTLE_AFTER_ATTEMPTS', 50);
  private readonly baseDelayMs = parseTtlMs('IDENTIK_THROTTLE_BASE_DELAY_MS', 200);
  private readonly maxDelayMs = parseTtlMs('IDENTIK_THROTTLE_MAX_DELAY_MS', 5000);

  /** Hold the request for its current escalation. */
  async wait(scope: ThrottleScope, subject: ThrottleSubject): Promise<void> {
    const delay = this.delayFor(scope, subject);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** Record one attempt (or failure) against both dimensions. */
  record(scope: ThrottleScope, subject: ThrottleSubject): void {
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

  /** The targeted Identity proved its credential: forget its history. */
  recordSuccess(scope: ThrottleScope, subject: ThrottleSubject): void {
    const key = this.identityKey(scope, subject.identity);
    if (key) this.attempts.delete(key);
  }

  /**
   * The delay this request should incur, without recording it. The larger of
   * the source and Identity delays wins, so an attack from many sources is
   * still slowed per Identity and an attack on many Identities is still
   * slowed per source.
   */
  private delayFor(scope: ThrottleScope, subject: ThrottleSubject): number {
    const now = Date.now();
    return Math.max(
      this.delayForKey(this.sourceKey(scope, subject.source), now),
      this.delayForKey(this.identityKey(scope, subject.identity), now),
    );
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

  private sourceKey(scope: ThrottleScope, source: string | null | undefined): string | null {
    return source ? `${scope}:source:${source}` : null;
  }

  private identityKey(scope: ThrottleScope, identity: string | null | undefined): string | null {
    return identity ? `${scope}:identity:${identity}` : null;
  }
}
