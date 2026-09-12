import { ConflictException, Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
import {
  OrganizationSettingsService,
  firstPasswordProblem,
} from '../settings/organization-settings.service';
import { recordAuditEvent } from '../storage/audit';
import { isUniqueViolation } from '../storage/sqlite';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';
import { normalizeEmail } from './email';
import { anonymizedHandle, anonymizedPseudonym } from './identity-state';

type ReservationInsert = { created: true; identityId: string } | { created: false };

type IdentityTokenKind = 'email_verification' | 'password_reset';

interface IdentityRow {
  id: string;
  organization_id: string;
  email: string;
  email_verified: number;
  anonymized_at: string | null;
}

/** The state levers' Organization-scoped target: enough to find, name, and
 * gate the Identity, and nothing that authenticates. */
interface IdentityTarget {
  id: string;
  organization_id: string;
  organization_name: string;
  email: string;
  email_verified: number;
  anonymized_at: string | null;
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
    private readonly settings: OrganizationSettingsService,
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
    const normalized = normalizeEmail(email);
    const row = this.db
      .prepare(
        `SELECT id, organization_id, email, email_verified, suspended_at, anonymized_at, password_hash
         FROM identities WHERE organization_id = ? AND email = ?`,
      )
      .get(organizationId, normalized) as
      | {
          id: string;
          organization_id: string;
          email: string;
          email_verified: number;
          suspended_at: string | null;
          anonymized_at: string | null;
          password_hash: string;
        }
      | undefined;

    const passwordOk = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !passwordOk) {
      return { ok: false, reason: 'invalid', ...(row ? { identityId: row.id } : {}) };
    }
    // An anonymized shell is terminal: its destroyed credential can never open
    // it again, whatever was presented.
    if (row.anonymized_at !== null) {
      return { ok: false, reason: 'invalid', identityId: row.id };
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
    // The Organization's password policy is a credential gate (ADR-0022):
    // refuse a weak password before any reservation is made. This is the
    // visitor's own input, so a 400 reveals nothing about email existence.
    this.assertPasswordPolicy(organization.id, input.password);
    const email = normalizeEmail(input.email);
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
      .prepare(
        'UPDATE identities SET email_verified = 1 WHERE id = ? AND email_verified = 0 AND anonymized_at IS NULL',
      )
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
    const email = normalizeEmail(input.email);
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
    // Uniform work: hash first, whatever the path, so a valid link with a weak
    // password and a dead link take the same time. The policy gate runs before
    // the token is consumed, so a weak password does not burn the reset link —
    // the End User can try again with a stronger one.
    const passwordHash = await hashPassword(password);
    const preview = this.previewToken('password_reset', token);
    if (preview) this.assertPasswordPolicy(preview.organizationId, password);

    const identityId = this.consumeToken('password_reset', token);
    if (!identityId) return false;

    const identity = this.findIdentityById(identityId);
    if (!identity || identity.anonymized_at !== null) return false;

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
        'SELECT id, organization_id, email, password_hash, anonymized_at FROM identities WHERE id = ?',
      )
      .get(input.identityId) as
      | {
          id: string;
          organization_id: string;
          email: string;
          password_hash: string;
          anonymized_at: string | null;
        }
      | undefined;
    if (!identity || identity.anonymized_at !== null) return false;

    const currentOk = await verifyPassword(input.currentPassword, identity.password_hash);
    if (!currentOk) {
      this.audit(identity.organization_id, 'identity.password_change.failed', {
        identityId: identity.id,
        email: identity.email,
        reason: 'invalid_current_password',
      });
      return false;
    }

    // The Organization's policy applies to every credential its Identities
    // set (ADR-0022), the self-service change included.
    this.assertPasswordPolicy(identity.organization_id, input.newPassword);
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
   * The Account Center's email-change request (ADR-0008, ADR-0018). The handle
   * moves only on proof of the *new* mailbox: the request parks a single-use,
   * expiring token bound to the new address and sends the link there, leaving
   * the Identity's email untouched until it is consumed (ADR-0005). The new
   * address must be unique in the Organization — held by a verified Identity
   * or an inert Unverified Reservation alike (ADR-0011) — and a refusal is
   * uniform in shape, with the reason travelling to the requested mailbox (like
   * sign-up, not the HTTP layer). A second request supersedes the first, so at
   * most one change is ever pending.
   */
  async requestEmailChange(input: { identityId: string; newEmail: string }): Promise<void> {
    const identity = this.findIdentityById(input.identityId);
    if (!identity || identity.anonymized_at !== null) return;
    const organizationName = this.organizationName(identity.organization_id);
    const newEmail = normalizeEmail(input.newEmail);

    if (!this.emailChangeAvailable(identity, newEmail)) {
      this.audit(identity.organization_id, 'identity.email_change.refused', {
        identityId: identity.id,
        email: identity.email,
        newEmail,
      });
      await this.sendEmailChangeRefusedEmail(newEmail, organizationName);
      return;
    }

    // One pending change per Identity: a fresh request invalidates the last.
    this.db
      .prepare('DELETE FROM email_change_requests WHERE identity_id = ? AND consumed_at IS NULL')
      .run(identity.id);

    const token = randomToken(32);
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO email_change_requests
           (id, organization_id, identity_id, new_email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        identity.organization_id,
        identity.id,
        newEmail,
        hashToken(token),
        new Date(now.getTime() + this.emailChangeTtlMs()).toISOString(),
        now.toISOString(),
      );
    this.audit(identity.organization_id, 'identity.email_change.requested', {
      identityId: identity.id,
      email: identity.email,
      newEmail,
    });
    await this.sendEmailChangeVerificationEmail(newEmail, organizationName, token);
  }

  /**
   * Clicking the change link: proof of the new mailbox. The token is consumed
   * atomically first (single-use), then the email column moves — the UNIQUE
   * (organization_id, email) constraint is the race-free arbiter if the address
   * was claimed between request and proof, in which case the change is refused
   * and the token stays spent. An anonymized Identity has no handle to move.
   */
  async verifyEmailChange(token: string): Promise<boolean> {
    const now = new Date().toISOString();
    const request = this.db
      .prepare(
        `UPDATE email_change_requests SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING identity_id, organization_id, new_email`,
      )
      .get(now, hashToken(token), now) as
      | { identity_id: string; organization_id: string; new_email: string }
      | undefined;
    if (!request) return false;

    const identity = this.findIdentityById(request.identity_id);
    if (!identity || identity.anonymized_at !== null) return false;

    try {
      const moved = this.db
        .prepare(
          'UPDATE identities SET email = ?, email_verified = 1 WHERE id = ? AND anonymized_at IS NULL',
        )
        .run(request.new_email, identity.id);
      if (moved.changes !== 1) return false;
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.audit(request.organization_id, 'identity.email_change.refused', {
          identityId: identity.id,
          email: identity.email,
          newEmail: request.new_email,
        });
        return false;
      }
      throw error;
    }

    this.audit(request.organization_id, 'identity.email_change.completed', {
      identityId: identity.id,
      email: request.new_email,
      previousEmail: identity.email,
    });
    return true;
  }

  /** The address a live email-change request would move the Identity to. */
  pendingEmailChange(identityId: string): string | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT new_email FROM email_change_requests
         WHERE identity_id = ? AND consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(identityId, now) as { new_email: string } | undefined;
    return row?.new_email ?? null;
  }

  /**
   * Whether the requested address is free to move to: not the Identity's own
   * current handle, not held by any Identity (verified or inert reservation),
   * and not the target of another Identity's live request.
   */
  private emailChangeAvailable(identity: IdentityRow, newEmail: string): boolean {
    if (newEmail === normalizeEmail(identity.email)) return false;
    const holder = this.db
      .prepare('SELECT 1 FROM identities WHERE organization_id = ? AND email = ?')
      .get(identity.organization_id, newEmail);
    if (holder) return false;
    const pending = this.db
      .prepare(
        `SELECT 1 FROM email_change_requests
         WHERE organization_id = ? AND new_email = ? AND identity_id != ?
           AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(identity.organization_id, newEmail, identity.id, new Date().toISOString());
    return pending === undefined;
  }

  private organizationName(organizationId: string): string {
    const row = this.db
      .prepare('SELECT name FROM organizations WHERE id = ?')
      .get(organizationId) as { name: string } | undefined;
    return row?.name ?? '';
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
    if (identity.anonymized_at !== null) {
      throw new ConflictException('the Identity has been anonymized');
    }
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
    // An anonymized shell is terminal: there is no actor left to suspend, and
    // the state must not be mutated (ADR-0007).
    if (identity.anonymized_at !== null) return;
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
   * Anonymize an Identity — what deletion means here (ADR-0007). The PII is
   * destroyed irreversibly: the email, the credential, every Enrollment, and
   * every pending mailbox-proof token. The Identity row survives only as a
   * pseudonymous shell so audit history stays attributable by identityId; the
   * old email, freed from the unique handle, is immediately reusable by a
   * fresh unlinked Identity. The stored shell handle is non-deliverable and
   * never matches a sign-up, so no mailbox-proof flow can revive it, and the
   * credential gate refuses the shell forever. Idempotent: a second call is a
   * true no-op.
   */
  anonymize(input: { organizationId: string; identityId: string; actor: string }): void {
    const identity = this.requireIdentity(input.organizationId, input.identityId);
    if (identity.anonymized_at !== null) return;

    const now = new Date().toISOString();
    const pseudonym = anonymizedPseudonym(identity.id);
    const shellHandle = anonymizedHandle(identity.id);

    // The terminal marker, the destruction of the shell's data, and the
    // pseudonymization of the surviving trail are one unit. `anonymized_at IS
    // NULL` is the race-free arbiter: a concurrent second anonymize rolls back
    // without duplicating the event.
    this.db.exec('BEGIN');
    try {
      const marked = this.db
        .prepare(
          `UPDATE identities
              SET email = ?, password_hash = ?, email_verified = 0, suspended_at = NULL,
                  anonymized_at = ?, sessions_revoked_at = ?
            WHERE id = ? AND anonymized_at IS NULL`,
        )
        .run(shellHandle, DUMMY_PASSWORD_HASH, now, now, identity.id);
      if (marked.changes !== 1) {
        this.db.exec('ROLLBACK');
        return;
      }
      this.db.prepare('DELETE FROM enrollments WHERE identity_id = ?').run(identity.id);
      this.db.prepare('DELETE FROM identity_tokens WHERE identity_id = ?').run(identity.id);
      this.db.prepare('DELETE FROM authorization_codes WHERE identity_id = ?').run(identity.id);
      this.db.prepare('DELETE FROM email_change_requests WHERE identity_id = ?').run(identity.id);
      // The durable key is the identityId; the email in historical details is
      // PII, so the old trail is re-attributed to the shell, never left naming
      // the person. Scoped to this Identity's events and the End-User
      // lifecycle kinds that carry only an email, so an Administrator
      // invitation mentioning the same address is never rewritten.
      this.db
        .prepare(
          `UPDATE audit_events SET detail = json_set(detail, '$.email', ?)
            WHERE organization_id = ?
              AND json_extract(detail, '$.email') = ?
              AND (json_extract(detail, '$.identityId') = ?
                   OR kind LIKE 'identity.%' OR kind LIKE 'enrollment.%')`,
        )
        .run(pseudonym, identity.organization_id, identity.email, identity.id);
      // An email-change trail names the requested (`newEmail`) and previous
      // (`previousEmail`) addresses, and its own `email` may not equal the
      // Identity's current handle; rewrite all three so no address survives
      // (ADR-0007).
      this.db
        .prepare(
          `UPDATE audit_events SET detail = json_set(detail, '$.email', ?)
            WHERE organization_id = ? AND json_extract(detail, '$.identityId') = ?
              AND kind LIKE 'identity.email_change.%'`,
        )
        .run(pseudonym, identity.organization_id, identity.id);
      this.db
        .prepare(
          `UPDATE audit_events SET detail = json_set(detail, '$.newEmail', ?)
            WHERE organization_id = ? AND json_extract(detail, '$.newEmail') IS NOT NULL
              AND json_extract(detail, '$.identityId') = ?`,
        )
        .run(pseudonym, identity.organization_id, identity.id);
      this.db
        .prepare(
          `UPDATE audit_events SET detail = json_set(detail, '$.previousEmail', ?)
            WHERE organization_id = ? AND json_extract(detail, '$.previousEmail') IS NOT NULL
              AND json_extract(detail, '$.identityId') = ?`,
        )
        .run(pseudonym, identity.organization_id, identity.id);
      this.adminAudit(identity.organization_id, input.actor, 'identity.anonymized', {
        identityId: identity.id,
        pseudonym,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    // The shell is already dead at every credential gate (`email_verified = 0`,
    // `anonymized_at` set); the cascade records the device deaths and revokes
    // the descendant refresh tokens explicitly.
    this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organization_id,
      reason: 'anonymization',
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
        'SELECT id, organization_id, email, email_verified, anonymized_at FROM identities WHERE organization_id = ? AND email = ?',
      )
      .get(organizationId, email) as IdentityRow | undefined;
  }

  private findIdentityById(identityId: string): IdentityRow | undefined {
    return this.db
      .prepare(
        'SELECT id, organization_id, email, email_verified, anonymized_at FROM identities WHERE id = ?',
      )
      .get(identityId) as IdentityRow | undefined;
  }

  /** The state levers' Organization-scoped target, or a 404. */
  private requireIdentity(organizationId: string, identityId: string): IdentityTarget {
    const row = this.db
      .prepare(
        `SELECT i.id, i.organization_id, o.name AS organization_name, i.email, i.email_verified,
                i.anonymized_at
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

  /**
   * The Identity and Organization behind a live mailbox-proof token, without
   * consuming it. Used to resolve the Organization's password policy before
   * the single-use token is spent.
   */
  private previewToken(
    kind: IdentityTokenKind,
    token: string,
  ): { identityId: string; organizationId: string } | undefined {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT t.identity_id AS identityId, i.organization_id AS organizationId
         FROM identity_tokens t JOIN identities i ON i.id = t.identity_id
         WHERE t.token_hash = ? AND t.kind = ? AND t.consumed_at IS NULL AND t.expires_at > ?`,
      )
      .get(hashToken(token), kind, now) as { identityId: string; organizationId: string } | undefined;
  }

  /** Refuse a password the Organization's policy floors reject (ADR-0022). */
  private assertPasswordPolicy(organizationId: string, password: string): void {
    const problem = firstPasswordProblem(this.settings.passwordPolicy(organizationId), password);
    if (!problem) return;
    throw new BadRequestException({
      error: 'password_too_weak',
      code: problem.code,
      message: problem.message,
    });
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

  private async sendEmailChangeVerificationEmail(
    email: string,
    organizationName: string,
    token: string,
  ): Promise<void> {
    const link = `${this.links.resolve()}/api/end-users/change-email?token=${encodeURIComponent(token)}`;
    await this.mail.send({
      to: email,
      subject: `Confirm your new email — ${organizationName}`,
      body:
        `Someone asked to change an identity's email at ${organizationName} to this address.\n\n` +
        `Confirm this address to complete the change by opening the link below:\n\n${link}\n\n` +
        `The link is single-use and expires soon. Until you confirm it, the old address stays in ` +
        `effect. If you did not ask for this, you can ignore this message.`,
    });
  }

  private async sendEmailChangeRefusedEmail(
    email: string,
    organizationName: string,
  ): Promise<void> {
    await this.mail.send({
      to: email,
      subject: `This email is already in use — ${organizationName}`,
      body:
        `Someone tried to change an identity's email at ${organizationName} to this address, ` +
        `but an identity with this email already exists.\n` +
        `No change was made — the address stays with its current identity.\n\n` +
        `If you have forgotten your password, use the "Forgot password" flow to choose a new one.\n` +
        `If this wasn't you, you can ignore this message.`,
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

  private emailChangeTtlMs(): number {
    return parseTtlMs('IDENTIK_EMAIL_CHANGE_TOKEN_TTL_MS', 60 * 60 * 1000);
  }
}
