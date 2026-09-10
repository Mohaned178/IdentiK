import { Inject, Injectable } from '@nestjs/common';
import { hashPassword, hashToken, randomToken } from '../crypto/password';
import { MailService } from '../mail/mail.service';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

/**
 * Link base for outbound email. Derived from the Instance's own deployed URL,
 * held in deployment configuration (the Instance Operator's trust fabric per
 * ADR-0022) — never the Host header of an incoming request, which an
 * attacker controls and would use to smuggle verification links to their own
 * server.
 */
@Injectable()
export class LinkBaseService {
  resolve(): string {
    const raw = process.env.IDENTIK_BASE_URL;
    if (!raw) {
      throw new Error(
        'IDENTIK_BASE_URL must be set to the externally reachable URL of this Instance ' +
          '(e.g. https://id.example.com) — it is the base for verification and reset links.',
      );
    }
    return raw.replace(/\/+$/, '');
  }
}

export enum SignUpOutcome {
  /** No Identity held the email: a fresh Unverified Reservation was created. */
  ReservationCreated = 'reservation-created',
  /** A verified Identity already held the email: the "sign in instead" refusal went out. */
  AlreadyVerified = 'already-verified',
  /**
   * An unverified reservation already held the email: the verification link
   * was re-sent (the mailbox's true owner can still claim it; ADR-0011).
   */
  VerificationResent = 'verification-resent',
}

export interface ReservationView {
  id: string;
  email: string;
  emailVerified: boolean;
}

/**
 * The End-User sign-up boundary (ADR-0011): sign-up creates an inert
 * Unverified Reservation — an Identity that cannot authenticate, enroll, or
 * do anything but wait for mailbox proof. Any proof of mailbox control
 * activates it.
 *
 * Email existence is never confirmed at the HTTP layer (ADR-0005): every
 * sign-up attempt performs the same work (password hash + one outbound
 * email) and returns the same response, whatever the outcome; the
 * accepted/refused distinction travels to the mailbox only.
 */
@Injectable()
export class IdentitiesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly mail: MailService,
    private readonly links: LinkBaseService,
  ) {}

  async signUp(
    organizationId: string,
    organizationName: string,
    input: { email: string; password: string },
  ): Promise<SignUpOutcome> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);

    const outcome = this.insertReservation(organizationId, email, passwordHash);

    switch (outcome) {
      case SignUpOutcome.ReservationCreated:
        await this.audit(organizationId, 'identity.reservation.created', { email });
        await this.sendVerificationEmail(email, organizationName);
        break;
      case SignUpOutcome.VerificationResent: {
        const identity = this.identityByEmail(email);
        if (!identity) throw new Error('reservation vanished before re-send');
        const token = this.issueTokenFor(identity.id);
        await this.audit(organizationId, 'identity.signup.refused', {
          email,
          outcome: 'verification-resent',
        });
        await this.sendVerificationEmail(email, organizationName, token);
        break;
      }
      case SignUpOutcome.AlreadyVerified:
        await this.audit(organizationId, 'identity.signup.refused', {
          email,
          outcome: 'already-verified',
        });
        await this.sendAlreadyRegisteredEmail(email, organizationName);
        break;
    }

    return outcome;
  }

  /**
   * Clicking the verification link: proof of mailbox control, single-use and
   * expiring. Success marks the email verified, activating the Identity;
   * failure returns null so the caller can render the invalid outcome.
   */
  async verifyEmail(token: string): Promise<ReservationView | null> {    const now = new Date().toISOString();
    const consumed = this.db
      .prepare(
        `UPDATE identity_tokens SET consumed_at = ?
         WHERE token_hash = ? AND kind = 'email_verification' AND consumed_at IS NULL AND expires_at > ?
         RETURNING identity_id`,
      )
      .get(await hashToken(token), await hashToken(token), now) as
      | { identity_id: string }
      | undefined;
    if (!consumed) return null;

    const verified = this.db
      .prepare('UPDATE identities SET email_verified = 1 WHERE id = ? AND email_verified = 0')
      .run(consumed.identity_id);
    if (verified.changes !== 1) return null;

    const identity = this.db
      .prepare('SELECT id, email, email_verified FROM identities WHERE id = ?')
      .get(consumed.identity_id) as { id: string; email: string; email_verified: number } | undefined;
    if (!identity) return null;

    const organizationId = this.organizationOf(identity.id);
    if (organizationId) {
      await this.audit(organizationId, 'identity.verification.completed', {
        identityId: identity.id,
        email: identity.email,
      });
    }
    return { id: identity.id, email: identity.email, emailVerified: identity.email_verified === 1 };
  }

  /**
   * Creates the reservation, or reports which refusal applies. The UNIQUE
   * (organization_id, email) constraint is the race-free arbiter: a violation
   * (including a lost race) maps to the same already-registered refusal.
   */
  private insertReservation(
    organizationId: string,
    email: string,
    passwordHash: string,
  ): SignUpOutcome {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          'INSERT INTO identities (id, organization_id, email, email_verified, password_hash, created_at) VALUES (?, ?, ?, 0, ?, ?)',
        )
        .run(uuid(), organizationId, email, passwordHash, now);
      return SignUpOutcome.ReservationCreated;
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
    }

    const existing = this.db
      .prepare(
        'SELECT email_verified FROM identities WHERE organization_id = ? AND email = ?',
      )
      .get(organizationId, email) as { email_verified: number } | undefined;
    return existing?.email_verified === 1
      ? SignUpOutcome.AlreadyVerified
      : SignUpOutcome.VerificationResent;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' &&
      error.message.includes('UNIQUE constraint failed')
    );
  }

  private identityByEmail(email: string): { id: string } | null {
    return (
      (this.db.prepare('SELECT id FROM identities WHERE email = ?').get(email) as
        | { id: string }
        | undefined) ?? null
    );
  }

  /** A fresh mailbox-proof token for the Identity holding this email. */
  private issueTokenFor(identityId: string): string {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.verificationTtlMs());
    this.db
      .prepare(
        "INSERT INTO identity_tokens (id, identity_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, 'email_verification', ?, ?, ?)",
      )
      .run(uuid(), identityId, hashToken(token), expiresAt.toISOString(), new Date().toISOString());
    return token;
  }

  private async sendVerificationEmail(
    email: string,
    organizationName: string,
    token?: string,
  ): Promise<void> {
    let verificationToken = token;
    if (!verificationToken) {
      const identity = this.identityByEmail(email);
      if (!identity) throw new Error('identity vanished before token issuance');
      verificationToken = this.issueTokenFor(identity.id);
    }
    const link = `${this.links.resolve()}/api/end-users/verify-email?token=${encodeURIComponent(verificationToken)}`;
    await this.mail.send({
      to: email,
      subject: `Verify your email — ${organizationName}`,
      body:
        `Welcome to ${organizationName}.\n\n` +
        `Confirm this address to activate your identity by opening the link below:\n\n${link}\n\n` +
        `The link is single-use and expires soon. If you did not sign up, you can ignore this message.`,
    });
  }

  private async sendAlreadyRegisteredEmail(email: string, organizationName: string): Promise<void> {
    await this.mail.send({
      to: email,
      subject: `You already have an identity with ${organizationName} — sign in instead`,
      body:
        `Someone tried to create a new identity with this email at ${organizationName}.\n` +
        `An identity with this email already exists — sign in instead.\n\n` +
        `If you have forgotten your password, use the "Forgot password" flow on the sign-in page.\n` +
        `If this wasn't you, you can ignore this message.`,
    });
  }

  private organizationOf(identityId: string): string | null {
    const row = this.db
      .prepare('SELECT organization_id FROM identities WHERE id = ?')
      .get(identityId) as { organization_id: string } | undefined;
    return row?.organization_id ?? null;
  }

  private async audit(
    organizationId: string,
    kind: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO audit_events (id, organization_id, kind, actor, detail, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(uuid(), organizationId, kind, 'end-user', JSON.stringify(detail), new Date().toISOString());
  }

  private verificationTtlMs(): number {
    const raw = Number(process.env.IDENTIK_VERIFICATION_TOKEN_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
  }
}
