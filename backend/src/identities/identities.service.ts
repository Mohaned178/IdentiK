import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { hashPassword, hashToken, randomToken } from '../crypto/password';
import { MailService } from '../mail/mail.service';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

/**
 * Link base for outbound email. Derived from the Instance's own deployed URL,
 * held in deployment configuration (the Instance Operator's trust fabric per
 * ADR-0022) — never the Host header of an incoming request, which an attacker
 * controls and would use to smuggle verification links to their own server.
 * Validated at boot so a misconfigured Instance fails closed, loudly.
 */
@Injectable()
export class LinkBaseService {
  private readonly base: string;

  constructor() {
    const raw = process.env.IDENTIK_BASE_URL;
    if (!raw) {
      throw new Error(
        'IDENTIK_BASE_URL must be set to the externally reachable URL of this Instance ' +
          '(e.g. https://id.example.com) — it is the base for verification and reset links.',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`IDENTIK_BASE_URL "${raw}" is not a valid absolute URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`IDENTIK_BASE_URL "${raw}" must be an http(s) URL.`);
    }
    this.base = raw.replace(/\/+$/, '');
  }

  resolve(): string {
    return this.base;
  }
}

type ReservationInsert = { created: true; identityId: string } | { created: false };

type IdentityTokenKind = 'email_verification' | 'password_reset';

interface IdentityRow {
  id: string;
  email: string;
  email_verified: number;
  suspended_at: string | null;
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
 *
 * A duplicate email — verified or not — is refused identically: the mailbox
 * gets "an identity with this email already exists — sign in instead". A
 * pre-claimed reservation is NEVER re-sent a verification link on a
 * duplicate attempt: whoever clicked it would activate the Identity with
 * the original (possibly attacker-chosen) password. The mailbox's true owner
 * heals through the forgot-password flow instead, which sets their own
 * password while proving the mailbox (ticket 04, ADR-0011).
 */
@Injectable()
export class IdentitiesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly mail: MailService,
    private readonly links: LinkBaseService,
  ) {}

  /**
   * The Organization this Instance's hosted End-User pages serve. One
   * Organization per Instance today (ADR-0001); hosted mode selects by host
   * later.
   */
  hostedOrganization(): { id: string; name: string } {
    const row = this.db
      .prepare('SELECT id, name FROM organizations ORDER BY created_at LIMIT 1')
      .get() as { id: string; name: string } | undefined;
    if (!row) throw new NotFoundException('no organization exists on this Instance');
    return row;
  }

  async signUp(input: { email: string; password: string }): Promise<void> {
    const organization = this.hostedOrganization();
    const email = input.email.trim().toLowerCase();
    // Uniform work: every path hashes a password and sends exactly one email.
    const passwordHash = await hashPassword(input.password);

    const reservation = this.insertReservation(organization.id, email, passwordHash);

    if (reservation.created) {
      this.audit(organization.id, 'identity.reservation.created', { email });
      const token = this.issueToken(
        reservation.identityId,
        'email_verification',
        this.verificationTtlMs(),
      );
      await this.sendVerificationEmail(email, organization.name, token);
    } else {
      this.audit(organization.id, 'identity.signup.refused', { email });
      await this.sendAlreadyRegisteredEmail(email, organization.name);
    }
  }

  /**
   * Clicking the verification link: proof of mailbox control, single-use and
   * expiring. Success marks the email verified, activating the Identity;
   * failure returns false so the caller renders the invalid outcome —
   * without saying whether the token was expired, used, or never existed.
   */
  async verifyEmail(token: string): Promise<boolean> {
    const tokenHash = await hashToken(token);
    const now = new Date().toISOString();
    const consumed = this.db
      .prepare(
        `UPDATE identity_tokens SET consumed_at = ?
         WHERE token_hash = ? AND kind = 'email_verification' AND consumed_at IS NULL AND expires_at > ?
         RETURNING identity_id`,
      )
      .get(now, tokenHash, now) as { identity_id: string } | undefined;
    if (!consumed) return false;

    const activated = this.db
      .prepare('UPDATE identities SET email_verified = 1 WHERE id = ? AND email_verified = 0')
      .run(consumed.identity_id);
    if (activated.changes !== 1) return false;

    const identity = this.db
      .prepare('SELECT organization_id, email FROM identities WHERE id = ?')
      .get(consumed.identity_id) as { organization_id: string; email: string } | undefined;
    if (!identity) return false;

    this.audit(identity.organization_id, 'identity.verification.completed', {
      identityId: consumed.identity_id,
      email: identity.email,
    });
    return true;
  }

  /**
   * "Forgot password" initiation (ticket 04). The response is deliberately
   * uniform (ADR-0005/0020): every request performs the same work and sends
   * exactly one email, so the HTTP layer never confirms whether an Identity
   * exists. Where one does, the mailbox receives a reset link; where it does
   * not, the mailbox receives a notice — the distinction travels to the
   * mailbox, never the response.
   */
  async requestPasswordReset(input: { email: string }): Promise<void> {
    const organization = this.hostedOrganization();
    const email = input.email.trim().toLowerCase();
    const identity = this.findIdentityByEmail(organization.id, email);

    if (!identity) {
      await this.sendNoIdentityEmail(email, organization.name);
      return;
    }

    this.audit(organization.id, 'identity.password_reset.requested', {
      identityId: identity.id,
      email,
    });
    const token = this.issueToken(identity.id, 'password_reset', this.resetTtlMs());
    await this.sendPasswordResetEmail(email, organization.name, token);
  }

  /**
   * Whether a reset link is live (exists, unconsumed, unexpired). The hosted
   * reset page asks this before drawing its form; it does not consume the
   * token — only completing the reset does.
   */
  validateResetToken(token: string): boolean {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 FROM identity_tokens
         WHERE token_hash = ? AND kind = 'password_reset' AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(hashToken(token), now);
    return row !== undefined;
  }

  /**
   * Completing a reset: mailbox proof in its second entry point (ADR-0011).
   * Consumes the single-use token, sets the new password, marks the email
   * verified (so an Unverified Reservation heals to its true owner in the same
   * act), and revokes every Session by advancing the Identity's revocation
   * watermark (ADR-0013). Suspension is deliberately left untouched: a
   * suspended Identity may reset, but recovery never restores its access
   * (ADR-0006). Failure returns false without revealing why.
   */
  async resetPassword(token: string, password: string): Promise<boolean> {
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    const consumed = this.db
      .prepare(
        `UPDATE identity_tokens SET consumed_at = ?
         WHERE token_hash = ? AND kind = 'password_reset' AND consumed_at IS NULL AND expires_at > ?
         RETURNING identity_id`,
      )
      .get(now, hashToken(token), now) as { identity_id: string } | undefined;
    if (!consumed) return false;

    const identity = this.db
      .prepare(
        'SELECT id, organization_id, email, email_verified, suspended_at FROM identities WHERE id = ?',
      )
      .get(consumed.identity_id) as
      | (IdentityRow & { organization_id: string })
      | undefined;
    if (!identity) return false;

    this.db
      .prepare(
        'UPDATE identities SET password_hash = ?, email_verified = 1, sessions_revoked_at = ? WHERE id = ?',
      )
      .run(passwordHash, now, identity.id);

    // Mailbox proof is mailbox proof (ADR-0011): a reset on an Unverified
    // Reservation activates it, audited like a verification click.
    if (identity.email_verified === 0) {
      this.audit(identity.organization_id, 'identity.verification.completed', {
        identityId: identity.id,
        email: identity.email,
      });
    }
    this.audit(identity.organization_id, 'identity.password_reset.completed', {
      identityId: identity.id,
      email: identity.email,
    });
    return true;
  }

  /**
   * Creates the reservation, or reports the email is held. The UNIQUE
   * (organization_id, email) constraint is the race-free arbiter: any
   * violation (including a lost race) is the same already-registered refusal.
   */
  private insertReservation(
    organizationId: string,
    email: string,
    passwordHash: string,
  ): ReservationInsert {
    const identityId = uuid();
    try {
      this.db
        .prepare(
          'INSERT INTO identities (id, organization_id, email, email_verified, password_hash, created_at) VALUES (?, ?, ?, 0, ?, ?)',
        )
        .run(identityId, organizationId, email, passwordHash, new Date().toISOString());
      return { created: true, identityId };
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      return { created: false };
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' &&
      error.message.includes('UNIQUE constraint failed')
    );
  }

  /** A fresh mailbox-proof token for one Identity. */
  private issueToken(identityId: string, kind: IdentityTokenKind, ttlMs: number): string {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + ttlMs);
    this.db
      .prepare(
        'INSERT INTO identity_tokens (id, identity_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(uuid(), identityId, kind, hashToken(token), expiresAt.toISOString(), new Date().toISOString());
    return token;
  }

  private findIdentityByEmail(organizationId: string, email: string): IdentityRow | undefined {
    return this.db
      .prepare(
        'SELECT id, email, email_verified, suspended_at FROM identities WHERE organization_id = ? AND email = ?',
      )
      .get(organizationId, email) as IdentityRow | undefined;
  }

  private async sendVerificationEmail(
    email: string,
    organizationName: string,
    token: string,
  ): Promise<void> {
    const link = `${this.links.resolve()}/api/end-users/verify-email?token=${encodeURIComponent(token)}`;
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
        `If you have forgotten your password, use the "Forgot password" flow to choose a new one.\n` +
        `If this wasn't you, you can ignore this message.`,
    });
  }

  private async sendPasswordResetEmail(
    email: string,
    organizationName: string,
    token: string,
  ): Promise<void> {
    const link = `${this.links.resolve()}/end-users/reset-password?token=${encodeURIComponent(token)}`;
    await this.mail.send({
      to: email,
      subject: `Reset your password — ${organizationName}`,
      body:
        `Someone asked to reset the password for your identity at ${organizationName}.\n\n` +
        `Choose a new password by opening the link below:\n\n${link}\n\n` +
        `The link is single-use and expires soon. If you did not ask for this, you can ignore this message.`,
    });
  }

  private async sendNoIdentityEmail(email: string, organizationName: string): Promise<void> {
    await this.mail.send({
      to: email,
      subject: `No identity with ${organizationName} uses this email`,
      body:
        `Someone asked to reset a password for this email at ${organizationName}, but no identity exists for it.\n\n` +
        `If this wasn't you, you can ignore this message. To start an identity, use the sign-up page.`,
    });
  }

  private audit(organizationId: string, kind: string, detail: Record<string, unknown>): void {
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

  private resetTtlMs(): number {
    const raw = Number(process.env.IDENTIK_RESET_TOKEN_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
  }
}
