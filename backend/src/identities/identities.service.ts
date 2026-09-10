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
      const token = this.issueTokenFor(reservation.identityId);
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
        `If you have forgotten your password, use the "Forgot password" flow on the sign-in page.\n` +
        `If this wasn't you, you can ignore this message.`,
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
}
