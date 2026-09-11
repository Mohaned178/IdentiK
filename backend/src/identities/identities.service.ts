import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashToken,
  randomToken,
  verifyPassword,
} from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { LinkBaseService } from '../config/link-base.service';
import { MailService } from '../mail/mail.service';
import { SessionsService } from '../sessions/sessions.service';
import { recordAuditEvent } from '../storage/audit';
import { isUniqueViolation } from '../storage/sqlite';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

type ReservationInsert = { created: true; identityId: string } | { created: false };

type IdentityTokenKind = 'email_verification' | 'password_reset';

interface IdentityRow {
  id: string;
  organization_id: string;
  email: string;
  email_verified: number;
}

/** The state levers' Organization-scoped target: enough to find, name, and
 * gate the Identity, and nothing that authenticates. */
interface IdentityTarget {
  id: string;
  organization_id: string;
  organization_name: string;
  email: string;
  email_verified: number;
}

export interface AuthenticatedIdentity {
  id: string;
  organizationId: string;
  email: string;
}

export type IdentityAuthentication =
  | { ok: true; identity: AuthenticatedIdentity }
  | { ok: false; reason: 'invalid' | 'unverified' | 'suspended'; identityId?: string };

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
 *
 * Recovery is the second mailbox-proof entry point. It answers uniformly
 * whether or not an Identity exists, and it only ever sets a credential: it
 * cannot un-suspend, so it is never a path back to access for a suspended
 * Identity (ADR-0006, gated at authentication in ticket 09/13).
 */
@Injectable()
export class IdentitiesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly mail: MailService,
    private readonly links: LinkBaseService,
    private readonly sessions: SessionsService,
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

  /**
   * Verify a credential at the authorization boundary (ADR-0011, ADR-0006).
   * Failure is uniform — unknown email, wrong password, unverified
   * reservation, and suspended Identity are indistinguishable to the caller;
   * the difference lives only in the audit detail. Verification always
   * performs the hash work, so timing does not reveal whether the email
   * exists. A suspended Identity is refused even with the correct password,
   * and recovery can never un-suspend it.
   */
  async authenticate(
    organizationId: string,
    email: string,
    password: string,
  ): Promise<IdentityAuthentication> {
    const normalized = email.trim().toLowerCase();
    const row = this.db
      .prepare(
        `SELECT id, organization_id, email, email_verified, suspended_at, password_hash
         FROM identities WHERE organization_id = ? AND email = ?`,
      )
      .get(organizationId, normalized) as
      | {
          id: string;
          organization_id: string;
          email: string;
          email_verified: number;
          suspended_at: string | null;
          password_hash: string;
        }
      | undefined;

    const passwordOk = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !passwordOk) {
      return { ok: false, reason: 'invalid', ...(row ? { identityId: row.id } : {}) };
    }
    if (row.suspended_at !== null) {
      return { ok: false, reason: 'suspended', identityId: row.id };
    }
    if (row.email_verified === 0) {
      return { ok: false, reason: 'unverified', identityId: row.id };
    }
    return {
      ok: true,
      identity: { id: row.id, organizationId: row.organization_id, email: row.email },
    };
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
    const identityId = this.consumeToken('email_verification', token);
    if (!identityId) return false;

    const activated = this.db
      .prepare('UPDATE identities SET email_verified = 1 WHERE id = ? AND email_verified = 0')
      .run(identityId);
    if (activated.changes !== 1) return false;

    const identity = this.db
      .prepare('SELECT organization_id, email FROM identities WHERE id = ?')
      .get(identityId) as { organization_id: string; email: string } | undefined;
    if (!identity) return false;

    this.audit(identity.organization_id, 'identity.verification.completed', {
      identityId,
      email: identity.email,
    });
    return true;
  }

  /**
   * "Forgot password" initiation (ticket 04). The response is deliberately
   * uniform (ADR-0005/0020): every request performs the same work (one
   * initiation audit + exactly one email), so neither shape nor timing
   * confirms whether an Identity exists. Where one does, the mailbox receives
   * a reset link; where it does not, the mailbox receives a notice — the
   * distinction travels to the mailbox, never the response.
   */
  async requestPasswordReset(input: { email: string }): Promise<void> {
    const organization = this.hostedOrganization();
    const email = input.email.trim().toLowerCase();
    const identity = this.findIdentityByEmail(organization.id, email);

    this.audit(organization.id, 'identity.password_reset.requested', {
      ...(identity ? { identityId: identity.id } : {}),
      email,
    });

    if (!identity) {
      await this.sendNoIdentityEmail(email, organization.name);
      return;
    }

    const token = this.issueToken(identity.id, 'password_reset', this.resetTtlMs());
    await this.sendPasswordResetEmail(email, organization.name, token);
  }

  /**
   * Whether a reset link is live (exists, unconsumed, unexpired). The hosted
   * reset page asks this before drawing its form; it does not consume the
   * token — only completing the reset does.
   */
  validateResetToken(token: string): boolean {
    return this.peekToken('password_reset', token);
  }

  /**
   * Completing a reset: mailbox proof in its second entry point (ADR-0011).
   * Consumes the single-use token, sets the new password, marks the email
   * verified (so an Unverified Reservation heals to its true owner in the same
   * act), and revokes every Session by advancing the Identity's revocation
   * watermark (ADR-0013). Recovery touches nothing but the credential: it can
   * never restore a suspended Identity's access, which the authentication
   * boundary (ticket 09) and suspension (ticket 13) gate. Failure returns
   * false without revealing why.
   */
  async resetPassword(token: string, password: string): Promise<boolean> {
    const passwordHash = await hashPassword(password);
    const identityId = this.consumeToken('password_reset', token);
    if (!identityId) return false;

    const identity = this.findIdentityById(identityId);
    if (!identity) return false;

    const now = new Date().toISOString();
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
   * The Account Center's self-service password change (ADR-0013, ADR-0018).
   * The current credential must be presented — an authenticated Session alone
   * does not authorize rewriting the credential its owner holds. On success,
   * the Session where the change happened survives and every other Session
   * dies with its descendant refresh tokens: the stolen-laptop cascade.
   * Returns false when the current password is wrong; that attempt is audited
   * even though nothing changed, because a wrong credential presented by a
   * live Session is exactly what a stolen device looks like. The cascade runs
   * before the credential lands, so a failure between them over-revokes
   * rather than leaving a changed password with live Sessions (ADR-0013).
   * Public pages never see this path; only the End User's own Session guard
   * does. This is the self-service counterpart of `resetPassword`, which is
   * mailbox-proof recovery rather than a presented-credential change.
   */
  async changePassword(input: {
    identityId: string;
    currentSessionId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<boolean> {
    const identity = this.db
      .prepare(
        'SELECT id, organization_id, email, password_hash FROM identities WHERE id = ?',
      )
      .get(input.identityId) as
      | { id: string; organization_id: string; email: string; password_hash: string }
      | undefined;
    if (!identity) return false;

    const currentOk = await verifyPassword(input.currentPassword, identity.password_hash);
    if (!currentOk) {
      this.audit(identity.organization_id, 'identity.password_change.failed', {
        identityId: identity.id,
        email: identity.email,
        reason: 'invalid_current_password',
      });
      return false;
    }

    const passwordHash = await hashPassword(input.newPassword);
    const otherSessionsRevoked = this.sessions.revokeOthersForIdentity({
      identityId: identity.id,
      organizationId: identity.organization_id,
      keepSessionId: input.currentSessionId,
      reason: 'password_change',
      actor: 'end-user',
    });
    this.db
      .prepare('UPDATE identities SET password_hash = ? WHERE id = ?')
      .run(passwordHash, identity.id);

    this.audit(identity.organization_id, 'identity.password_change.completed', {
      identityId: identity.id,
      email: identity.email,
      otherSessionsRevoked,
    });
    return true;
  }

  /**
   * The Administrator's force-reset lever (ADR-0008): a state lever that
   * never sets, reads, or displays a credential. It sends ticket 04's
   * password-reset link to the Identity's existing verified email and revokes
   * every Session, so the devices that exist at the click are evicted.
   * Recovery completes through the same mailbox-proof flow as forgot-password:
   * the link sets the new credential, and completion revokes every Session
   * again through the reset watermark — including any Session created between
   * the lever and the click. The mail goes out before the cascade, so a
   * failure cannot leave every device dead with no recovery link delivered.
   * A suspended Identity still receives the mail and may complete the reset;
   * the suspension gate keeps authentication refused (ADR-0006), so the lever
   * can never restore access by itself.
   */
  async forcePasswordReset(input: {
    organizationId: string;
    identityId: string;
    actor: string;
  }): Promise<void> {
    const identity = this.requireIdentity(input.organizationId, input.identityId);
    // The lever's premise is an Identity with a proven mailbox: an Unverified
    // Reservation has no verified email to deliver to, and "force password
    // reset" would be a contradiction — there is no credential its owner has
    // ever held. Reservations heal through the mailbox-proof flows instead.
    if (identity.email_verified === 0) {
      throw new ConflictException('the Identity has no verified email');
    }

    const token = this.issueToken(identity.id, 'password_reset', this.resetTtlMs());
    // The lever's pull is recorded before delivery, like the self-service
    // request: an Administrator's security action must be auditable even when
    // the transport fails afterwards.
    this.adminAudit(identity.organization_id, input.actor, 'identity.password_reset.forced', {
      identityId: identity.id,
      email: identity.email,
    });
    await this.sendPasswordResetEmail(identity.email, identity.organization_name, token);
    this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organization_id,
      reason: 'password_reset',
      actor: input.actor,
    });
  }

  /**
   * Suspend an Identity Organization-wide (ADR-0006): new authentication is
   * refused at the credential gate, and every live platform Session dies in
   * the same action, carrying its descendant refresh tokens with it. The
   * Organization scope is part of the lookup, so a foreign id is "not found",
   * never a cross-Organization lever.
   */
  suspend(input: { organizationId: string; identityId: string; actor: string }): void {
    const identity = this.requireIdentity(input.organizationId, input.identityId);
    const changed = this.db
      .prepare('UPDATE identities SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL')
      .run(new Date().toISOString(), identity.id);
    if (changed.changes !== 1) return;

    this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organization_id,
      reason: 'suspension',
      actor: input.actor,
    });
    this.adminAudit(identity.organization_id, input.actor, 'identity.suspended', {
      identityId: identity.id,
      email: identity.email,
    });
  }

  /**
   * Unsuspend is the reverse lever, but not an undo of the cascade: the
   * Identity may authenticate again, while the Sessions killed by suspension
   * stay dead. Advancing the revocation watermark keeps a Session that slipped
   * through the suspension race from coming back to life here.
   */
  unsuspend(input: { organizationId: string; identityId: string; actor: string }): void {
    const identity = this.requireIdentity(input.organizationId, input.identityId);
    const changed = this.db
      .prepare(
        'UPDATE identities SET suspended_at = NULL, sessions_revoked_at = ? WHERE id = ? AND suspended_at IS NOT NULL',
      )
      .run(new Date().toISOString(), identity.id);
    if (changed.changes === 1) {
      this.adminAudit(identity.organization_id, input.actor, 'identity.unsuspended', {
        identityId: identity.id,
        email: identity.email,
      });
    }
  }

  /**
   * Revoke every Session of one Identity without touching its state — the
   * device-eviction lever, distinct from suspension's "this actor is done".
   */
  revokeAllSessions(input: {
    organizationId: string;
    identityId: string;
    actor: string;
  }): number {
    const identity = this.requireIdentity(input.organizationId, input.identityId);
    return this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organization_id,
      reason: 'administrator',
      actor: input.actor,
    });
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
      if (!isUniqueViolation(error)) throw error;
      return { created: false };
    }
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
        'SELECT id, organization_id, email, email_verified FROM identities WHERE organization_id = ? AND email = ?',
      )
      .get(organizationId, email) as IdentityRow | undefined;
  }

  private findIdentityById(identityId: string): IdentityRow | undefined {
    return this.db
      .prepare(
        'SELECT id, organization_id, email, email_verified FROM identities WHERE id = ?',
      )
      .get(identityId) as IdentityRow | undefined;
  }

  /** The state levers' Organization-scoped target, or a 404. */
  private requireIdentity(organizationId: string, identityId: string): IdentityTarget {
    const row = this.db
      .prepare(
        `SELECT i.id, i.organization_id, o.name AS organization_name, i.email, i.email_verified
         FROM identities i JOIN organizations o ON o.id = i.organization_id
         WHERE i.id = ? AND i.organization_id = ?`,
      )
      .get(identityId, organizationId) as IdentityTarget | undefined;
    if (!row) throw new NotFoundException('no such Identity');
    return row;
  }

  /**
   * Consume a live mailbox-proof token of one kind, returning its Identity, or
   * undefined if it is missing, already used, or expired. The WHERE clause is
   * the race-free single-use arbiter.
   */
  private consumeToken(kind: IdentityTokenKind, token: string): string | undefined {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `UPDATE identity_tokens SET consumed_at = ?
         WHERE token_hash = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING identity_id`,
      )
      .get(now, hashToken(token), kind, now) as { identity_id: string } | undefined;
    return row?.identity_id;
  }

  /** Whether a live mailbox-proof token of one kind exists — without consuming it. */
  private peekToken(kind: IdentityTokenKind, token: string): boolean {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        'SELECT 1 FROM identity_tokens WHERE token_hash = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?',
      )
      .get(hashToken(token), kind, now);
    return row !== undefined;
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
    recordAuditEvent(this.db, { organizationId, actor: 'end-user', kind, detail });
  }

  /** An Administrator's state lever, attributed to the Administrator. */
  private adminAudit(
    organizationId: string,
    actor: string,
    kind: string,
    detail: Record<string, unknown>,
  ): void {
    recordAuditEvent(this.db, { organizationId, actor, kind, detail });
  }

  private verificationTtlMs(): number {
    return parseTtlMs('IDENTIK_VERIFICATION_TOKEN_TTL_MS', 24 * 60 * 60 * 1000);
  }

  private resetTtlMs(): number {
    return parseTtlMs('IDENTIK_RESET_TOKEN_TTL_MS', 60 * 60 * 1000);
  }
}
