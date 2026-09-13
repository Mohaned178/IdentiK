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
import { isUniqueViolation } from '../storage/postgres';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';
import { normalizeEmail } from './email';
import { anonymizedHandle, anonymizedPseudonym, identityGate } from './identity-state';

type ReservationInsert = { created: true; identityId: string } | { created: false };

type IdentityTokenKind = 'email_verification' | 'password_reset';

/**
 * The Identity fields the mailbox-proof and state-lever flows need. The
 * password hash is deliberately absent: anything that authenticates stays in
 * the credential paths, never in a row handed to an Administrator lever
 * (ADR-0008).
 */
const IDENTITY_SUMMARY_SELECT = {
  id: true,
  organizationId: true,
  email: true,
  emailVerified: true,
  anonymizedAt: true,
} as const;

type IdentitySummary = {
  id: string;
  organizationId: string;
  email: string;
  emailVerified: number;
  anonymizedAt: string | null;
};

/** The state levers' Organization-scoped target: enough to find, name, and
 * gate the Identity, and nothing that authenticates. */
type IdentityTarget = IdentitySummary & { organization: { name: string } };

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
  async hostedOrganization(): Promise<{ id: string; name: string }> {
    const row = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
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
    const row = await this.db.identity.findUnique({
      where: { organizationId_email: { organizationId, email: normalized } },
    });

    const passwordOk = await verifyPassword(password, row?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!row || !passwordOk) {
      return { ok: false, reason: 'invalid', ...(row ? { identityId: row.id } : {}) };
    }
    // An anonymized shell is terminal: its destroyed credential can never open
    // it again, whatever was presented. Suspension and an unverified
    // reservation carry their own refusal reasons for the audit trail.
    const gate = identityGate(row);
    if (gate !== 'live') {
      return { ok: false, reason: gate === 'anonymized' ? 'invalid' : gate, identityId: row.id };
    }
    return {
      ok: true,
      identity: { id: row.id, organizationId: row.organizationId, email: row.email },
    };
  }

  async signUp(input: { email: string; password: string }): Promise<void> {
    const organization = await this.hostedOrganization();
    // The Organization's password policy is a credential gate (ADR-0022):
    // refuse a weak password before any reservation is made. This is the
    // visitor's own input, so a 400 reveals nothing about email existence.
    await this.assertPasswordPolicy(organization.id, input.password);
    const email = normalizeEmail(input.email);
    // Uniform work: every path hashes a password and sends exactly one email.
    const passwordHash = await hashPassword(input.password);

    const reservation = await this.insertReservation(organization.id, email, passwordHash);

    if (reservation.created) {
      await recordAuditEvent(this.db, {
        organizationId: organization.id,
        actor: 'end-user',
        kind: 'identity.reservation.created',
        detail: { email },
      });
      const token = await this.issueToken(
        reservation.identityId,
        'email_verification',
        this.verificationTtlMs(),
      );
      await this.sendVerificationEmail(email, organization.name, token);
    } else {
      await recordAuditEvent(this.db, {
        organizationId: organization.id,
        actor: 'end-user',
        kind: 'identity.signup.refused',
        detail: { email },
      });
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
    const identityId = await this.consumeToken('email_verification', token);
    if (!identityId) return false;

    const activated = await this.db.identity.updateMany({
      where: { id: identityId, emailVerified: 0, anonymizedAt: null },
      data: { emailVerified: 1 },
    });
    if (activated.count !== 1) return false;

    const identity = await this.db.identity.findUnique({
      where: { id: identityId },
      select: { organizationId: true, email: true },
    });
    if (!identity) return false;

    await recordAuditEvent(this.db, {
      organizationId: identity.organizationId,
      actor: 'end-user',
      kind: 'identity.verification.completed',
      detail: { identityId, email: identity.email },
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
    const organization = await this.hostedOrganization();
    const email = normalizeEmail(input.email);
    const identity = await this.findIdentityByEmail(organization.id, email);

    await recordAuditEvent(this.db, {
      organizationId: organization.id,
      actor: 'end-user',
      kind: 'identity.password_reset.requested',
      detail: { ...(identity ? { identityId: identity.id } : {}), email },
    });

    if (!identity) {
      await this.sendNoIdentityEmail(email, organization.name);
      return;
    }

    const token = await this.issueToken(identity.id, 'password_reset', this.resetTtlMs());
    await this.sendPasswordResetEmail(email, organization.name, token);
  }

  /**
   * Whether a reset link is live (exists, unconsumed, unexpired). The hosted
   * reset page asks this before drawing its form; it does not consume the
   * token — only completing the reset does.
   */
  async validateResetToken(token: string): Promise<boolean> {
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
    const preview = await this.previewToken('password_reset', token);
    if (preview) await this.assertPasswordPolicy(preview.organizationId, password);

    const identityId = await this.consumeToken('password_reset', token);
    if (!identityId) return false;

    const identity = await this.findIdentityById(identityId);
    if (!identity || identity.anonymizedAt !== null) return false;

    const now = new Date().toISOString();
    await this.db.identity.update({
      where: { id: identity.id },
      data: { passwordHash, emailVerified: 1, sessionsRevokedAt: now },
    });

    // Mailbox proof is mailbox proof (ADR-0011): a reset on an Unverified
    // Reservation activates it, audited like a verification click.
    if (identity.emailVerified === 0) {
      await recordAuditEvent(this.db, {
        organizationId: identity.organizationId,
        actor: 'end-user',
        kind: 'identity.verification.completed',
        detail: { identityId: identity.id, email: identity.email },
      });
    }
    await recordAuditEvent(this.db, {
      organizationId: identity.organizationId,
      actor: 'end-user',
      kind: 'identity.password_reset.completed',
      detail: { identityId: identity.id, email: identity.email },
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
    const identity = await this.db.identity.findUnique({
      where: { id: input.identityId },
      select: {
        id: true,
        organizationId: true,
        email: true,
        passwordHash: true,
        anonymizedAt: true,
      },
    });
    if (!identity || identity.anonymizedAt !== null) return false;

    const currentOk = await verifyPassword(input.currentPassword, identity.passwordHash);
    if (!currentOk) {
      await recordAuditEvent(this.db, {
        organizationId: identity.organizationId,
        actor: 'end-user',
        kind: 'identity.password_change.failed',
        detail: {
          identityId: identity.id,
          email: identity.email,
          reason: 'invalid_current_password',
        },
      });
      return false;
    }

    // The Organization's policy applies to every credential its Identities
    // set (ADR-0022), the self-service change included.
    await this.assertPasswordPolicy(identity.organizationId, input.newPassword);
    const passwordHash = await hashPassword(input.newPassword);
    const otherSessionsRevoked = await this.sessions.revokeOthersForIdentity({
      identityId: identity.id,
      organizationId: identity.organizationId,
      keepSessionId: input.currentSessionId,
      reason: 'password_change',
      actor: 'end-user',
    });
    await this.db.identity.update({
      where: { id: identity.id },
      data: { passwordHash },
    });

    await recordAuditEvent(this.db, {
      organizationId: identity.organizationId,
      actor: 'end-user',
      kind: 'identity.password_change.completed',
      detail: {
        identityId: identity.id,
        email: identity.email,
        otherSessionsRevoked,
      },
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
    const identity = await this.findIdentityById(input.identityId);
    if (!identity || identity.anonymizedAt !== null) return;
    const organizationName = await this.organizationName(identity.organizationId);
    const newEmail = normalizeEmail(input.newEmail);

    if (!(await this.emailChangeAvailable(identity, newEmail))) {
      await recordAuditEvent(this.db, {
        organizationId: identity.organizationId,
        actor: 'end-user',
        kind: 'identity.email_change.refused',
        detail: {
          identityId: identity.id,
          email: identity.email,
          newEmail,
        },
      });
      await this.sendEmailChangeRefusedEmail(newEmail, organizationName);
      return;
    }

    // One pending change per Identity: a fresh request invalidates the last.
    await this.db.emailChangeRequest.deleteMany({
      where: { identityId: identity.id, consumedAt: null },
    });

    const token = randomToken(32);
    const now = new Date();
    await this.db.emailChangeRequest.create({
      data: {
        id: uuid(),
        organizationId: identity.organizationId,
        identityId: identity.id,
        newEmail,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + this.emailChangeTtlMs()).toISOString(),
        createdAt: now.toISOString(),
      },
    });
    await recordAuditEvent(this.db, {
      organizationId: identity.organizationId,
      actor: 'end-user',
      kind: 'identity.email_change.requested',
      detail: {
        identityId: identity.id,
        email: identity.email,
        newEmail,
      },
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
    const tokenHash = hashToken(token);
    // The guarded claim is the single-use arbiter; the request is read back
    // only once it is ours.
    const claimed = await this.db.emailChangeRequest.updateMany({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return false;
    const request = await this.db.emailChangeRequest.findUnique({ where: { tokenHash } });
    if (!request) return false;

    const identity = await this.findIdentityById(request.identityId);
    if (!identity || identity.anonymizedAt !== null) return false;

    try {
      const moved = await this.db.identity.updateMany({
        where: { id: identity.id, anonymizedAt: null },
        data: { email: request.newEmail, emailVerified: 1 },
      });
      if (moved.count !== 1) return false;
    } catch (error) {
      if (isUniqueViolation(error)) {
        await recordAuditEvent(this.db, {
          organizationId: request.organizationId,
          actor: 'end-user',
          kind: 'identity.email_change.refused',
          detail: {
            identityId: identity.id,
            email: identity.email,
            newEmail: request.newEmail,
          },
        });
        // The address was claimed between request and proof: the refusal
        // reaches the mailbox, like every other refusal in this flow.
        await this.sendEmailChangeRefusedEmail(
          request.newEmail,
          await this.organizationName(request.organizationId),
        );
        return false;
      }
      throw error;
    }

    await recordAuditEvent(this.db, {
      organizationId: request.organizationId,
      actor: 'end-user',
      kind: 'identity.email_change.completed',
      detail: {
        identityId: identity.id,
        email: request.newEmail,
        previousEmail: identity.email,
      },
    });
    return true;
  }

  /** The address a live email-change request would move the Identity to. */
  async pendingEmailChange(identityId: string): Promise<string | null> {
    const now = new Date().toISOString();
    const row = await this.db.emailChangeRequest.findFirst({
      where: { identityId, consumedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { newEmail: true },
    });
    return row?.newEmail ?? null;
  }

  /**
   * Whether the requested address is free to move to: not the Identity's own
   * current handle, not held by any Identity (verified or inert reservation),
   * and not the target of another Identity's live request.
   */
  private async emailChangeAvailable(identity: IdentitySummary, newEmail: string): Promise<boolean> {
    if (newEmail === normalizeEmail(identity.email)) return false;
    const holder = await this.db.identity.findFirst({
      where: { organizationId: identity.organizationId, email: newEmail },
      select: { id: true },
    });
    if (holder) return false;
    const pending = await this.db.emailChangeRequest.findFirst({
      where: {
        organizationId: identity.organizationId,
        newEmail,
        identityId: { not: identity.id },
        consumedAt: null,
        expiresAt: { gt: new Date().toISOString() },
      },
      select: { id: true },
    });
    return pending === null;
  }

  private async organizationName(organizationId: string): Promise<string> {
    const row = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
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
    const identity = await this.requireIdentity(input.organizationId, input.identityId);
    if (identity.anonymizedAt !== null) {
      throw new ConflictException('the Identity has been anonymized');
    }
    // The lever's premise is an Identity with a proven mailbox: an Unverified
    // Reservation has no verified email to deliver to, and "force password
    // reset" would be a contradiction — there is no credential its owner has
    // ever held. Reservations heal through the mailbox-proof flows instead.
    if (identity.emailVerified === 0) {
      throw new ConflictException('the Identity has no verified email');
    }

    const token = await this.issueToken(identity.id, 'password_reset', this.resetTtlMs());
    // The lever's pull is recorded before delivery, like the self-service
    // request: an Administrator's security action must be auditable even when
    // the transport fails afterwards.
    await recordAuditEvent(this.db, {
      organizationId: identity.organizationId,
      actor: input.actor,
      kind: 'identity.password_reset.forced',
      detail: { identityId: identity.id, email: identity.email },
    });
    await this.sendPasswordResetEmail(identity.email, identity.organization.name, token);
    await this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organizationId,
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
  async suspend(input: {
    organizationId: string;
    identityId: string;
    actor: string;
  }): Promise<void> {
    const identity = await this.requireIdentity(input.organizationId, input.identityId);
    // An anonymized shell is terminal: there is no actor left to suspend, and
    // the state must not be mutated (ADR-0007).
    if (identity.anonymizedAt !== null) return;
    const changed = await this.db.identity.updateMany({
      where: { id: identity.id, suspendedAt: null },
      data: { suspendedAt: new Date().toISOString() },
    });
    if (changed.count !== 1) return;

    await this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organizationId,
      reason: 'suspension',
      actor: input.actor,
    });
    await recordAuditEvent(this.db, {
      organizationId: identity.organizationId,
      actor: input.actor,
      kind: 'identity.suspended',
      detail: { identityId: identity.id, email: identity.email },
    });
  }

  /**
   * Unsuspend is the reverse lever, but not an undo of the cascade: the
   * Identity may authenticate again, while the Sessions killed by suspension
   * stay dead. Advancing the revocation watermark keeps a Session that slipped
   * through the suspension race from coming back to life here.
   */
  async unsuspend(input: {
    organizationId: string;
    identityId: string;
    actor: string;
  }): Promise<void> {
    const identity = await this.requireIdentity(input.organizationId, input.identityId);
    const changed = await this.db.identity.updateMany({
      where: { id: identity.id, suspendedAt: { not: null } },
      data: { suspendedAt: null, sessionsRevokedAt: new Date().toISOString() },
    });
    if (changed.count === 1) {
      await recordAuditEvent(this.db, {
        organizationId: identity.organizationId,
        actor: input.actor,
        kind: 'identity.unsuspended',
        detail: { identityId: identity.id, email: identity.email },
      });
    }
  }

  /**
   * Revoke every Session of one Identity without touching its state — the
   * device-eviction lever, distinct from suspension's "this actor is done".
   */
  async revokeAllSessions(input: {
    organizationId: string;
    identityId: string;
    actor: string;
  }): Promise<number> {
    const identity = await this.requireIdentity(input.organizationId, input.identityId);
    return this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organizationId,
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
  async anonymize(input: {
    organizationId: string;
    identityId: string;
    actor: string;
  }): Promise<void> {
    const identity = await this.requireIdentity(input.organizationId, input.identityId);
    if (identity.anonymizedAt !== null) return;

    const now = new Date().toISOString();
    const pseudonym = anonymizedPseudonym(identity.id);
    const shellHandle = anonymizedHandle(identity.id);

    // The terminal marker, the destruction of the shell's data, and the
    // pseudonymization of the surviving trail are one unit. `anonymized_at IS
    // NULL` is the race-free arbiter: a concurrent second anonymize commits
    // without duplicating the event.
    await this.db.transaction(async (tx) => {
      const marked = await tx.identity.updateMany({
        where: { id: identity.id, anonymizedAt: null },
        data: {
          email: shellHandle,
          passwordHash: DUMMY_PASSWORD_HASH,
          emailVerified: 0,
          suspendedAt: null,
          anonymizedAt: now,
          sessionsRevokedAt: now,
        },
      });
      if (marked.count !== 1) return;

      await tx.enrollment.deleteMany({ where: { identityId: identity.id } });
      await tx.identityToken.deleteMany({ where: { identityId: identity.id } });
      await tx.authorizationCode.deleteMany({ where: { identityId: identity.id } });
      // Pending changes to the address being freed die with it, and the freed
      // address is released from any other Identity's request trail below.
      await tx.emailChangeRequest.deleteMany({
        where: {
          OR: [
            { identityId: identity.id },
            { organizationId: identity.organizationId, newEmail: identity.email },
          ],
        },
      });
      // Deliberate raw-SQL exceptions (ADR-0027): the audit detail is a JSON
      // text column and these are jsonb_set field rewrites — typed updates
      // cannot express them. Every statement is parameterized, never
      // interpolated. The durable key is the identityId; the email in
      // historical details is PII, so the old trail is re-attributed to the
      // shell, never left naming the person. Scoped to this Identity's events
      // and the End-User lifecycle kinds that carry only an email, so an
      // Administrator invitation mentioning the same address is never
      // rewritten.
      await tx.run(
        `UPDATE audit_events
            SET detail = jsonb_set(detail::jsonb, '{email}', to_jsonb(?::text))::text
          WHERE organization_id = ?
            AND (detail::jsonb ->> 'email') = ?
            AND ((detail::jsonb ->> 'identityId') = ?
                 OR kind LIKE 'identity.%' OR kind LIKE 'enrollment.%')`,
        [pseudonym, identity.organizationId, identity.email, identity.id],
      );
      // An email-change trail names the requested (`newEmail`) and previous
      // (`previousEmail`) addresses, and its own `email` may not equal the
      // Identity's current handle; rewrite all three so no address survives
      // (ADR-0007).
      await tx.run(
        `UPDATE audit_events
            SET detail = jsonb_set(detail::jsonb, '{email}', to_jsonb(?::text))::text
          WHERE organization_id = ? AND (detail::jsonb ->> 'identityId') = ?
            AND kind LIKE 'identity.email_change.%'`,
        [pseudonym, identity.organizationId, identity.id],
      );
      await tx.run(
        `UPDATE audit_events
            SET detail = jsonb_set(detail::jsonb, '{newEmail}', to_jsonb(?::text))::text
          WHERE organization_id = ? AND (detail::jsonb ->> 'newEmail') IS NOT NULL
            AND (detail::jsonb ->> 'identityId') = ?`,
        [pseudonym, identity.organizationId, identity.id],
      );
      await tx.run(
        `UPDATE audit_events
            SET detail = jsonb_set(detail::jsonb, '{previousEmail}', to_jsonb(?::text))::text
          WHERE organization_id = ? AND (detail::jsonb ->> 'previousEmail') IS NOT NULL
            AND (detail::jsonb ->> 'identityId') = ?`,
        [pseudonym, identity.organizationId, identity.id],
      );
      // The freed address may also appear as some *other* Identity's requested
      // or previous address; destroy it there too so deletion leaves no trace
      // of the person (ADR-0007).
      await tx.run(
        `UPDATE audit_events
            SET detail = jsonb_set(detail::jsonb, '{newEmail}', to_jsonb(?::text))::text
          WHERE organization_id = ? AND (detail::jsonb ->> 'newEmail') = ?`,
        [pseudonym, identity.organizationId, identity.email],
      );
      await tx.run(
        `UPDATE audit_events
            SET detail = jsonb_set(detail::jsonb, '{previousEmail}', to_jsonb(?::text))::text
          WHERE organization_id = ? AND (detail::jsonb ->> 'previousEmail') = ?`,
        [pseudonym, identity.organizationId, identity.email],
      );
      await recordAuditEvent(tx, {
        organizationId: identity.organizationId,
        actor: input.actor,
        kind: 'identity.anonymized',
        detail: { identityId: identity.id, pseudonym },
      });
    });

    // The shell is already dead at every credential gate (`email_verified = 0`,
    // `anonymized_at` set); the cascade records the device deaths and revokes
    // the descendant refresh tokens explicitly.
    await this.sessions.revokeAllForIdentity({
      identityId: identity.id,
      organizationId: identity.organizationId,
      reason: 'anonymization',
      actor: input.actor,
    });
  }

  /**
   * Creates the reservation, or reports the email is held. The UNIQUE
   * (organization_id, email) constraint is the race-free arbiter: any
   * violation (including a lost race) is the same already-registered refusal.
   */
  private async insertReservation(
    organizationId: string,
    email: string,
    passwordHash: string,
  ): Promise<ReservationInsert> {
    // Duplicate detection is a read, not a failed insert: a typed unique
    // violation costs tens of milliseconds inside the ORM, and the caught
    // exception would time-leak email existence at the sign-up boundary
    // (ADR-0005). The unique constraint remains the race arbiter — a lost
    // race still surfaces as the violation caught below.
    const existing = await this.db.identity.findUnique({
      where: { organizationId_email: { organizationId, email } },
      select: { id: true },
    });
    if (existing) return { created: false };

    const identityId = uuid();
    try {
      await this.db.identity.create({
        data: {
          id: identityId,
          organizationId,
          email,
          emailVerified: 0,
          passwordHash,
          createdAt: new Date().toISOString(),
        },
      });
      return { created: true, identityId };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return { created: false };
    }
  }

  /** A fresh mailbox-proof token for one Identity. */
  private async issueToken(
    identityId: string,
    kind: IdentityTokenKind,
    ttlMs: number,
  ): Promise<string> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.db.identityToken.create({
      data: {
        id: uuid(),
        identityId,
        kind,
        tokenHash: hashToken(token),
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date().toISOString(),
      },
    });
    return token;
  }

  private async findIdentityByEmail(
    organizationId: string,
    email: string,
  ): Promise<IdentitySummary | null> {
    return this.db.identity.findUnique({
      where: { organizationId_email: { organizationId, email } },
      select: IDENTITY_SUMMARY_SELECT,
    });
  }

  private async findIdentityById(identityId: string): Promise<IdentitySummary | null> {
    return this.db.identity.findUnique({
      where: { id: identityId },
      select: IDENTITY_SUMMARY_SELECT,
    });
  }

  /** The state levers' Organization-scoped target, or a 404. */
  private async requireIdentity(
    organizationId: string,
    identityId: string,
  ): Promise<IdentityTarget> {
    const row = await this.db.identity.findFirst({
      where: { id: identityId, organizationId },
      select: {
        ...IDENTITY_SUMMARY_SELECT,
        organization: { select: { name: true } },
      },
    });
    if (!row) throw new NotFoundException('no such Identity');
    return row;
  }

  /**
   * Consume a live mailbox-proof token of one kind, returning its Identity, or
   * undefined if it is missing, already used, or expired. The guarded update's
   * count is the race-free single-use arbiter; the row is read back only after
   * the claim succeeds.
   */
  private async consumeToken(
    kind: IdentityTokenKind,
    token: string,
  ): Promise<string | undefined> {
    const now = new Date().toISOString();
    const tokenHash = hashToken(token);
    const claimed = await this.db.identityToken.updateMany({
      where: { tokenHash, kind, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return undefined;
    const row = await this.db.identityToken.findUnique({
      where: { tokenHash },
      select: { identityId: true },
    });
    return row?.identityId;
  }

  /** Whether a live mailbox-proof token of one kind exists — without consuming it. */
  private async peekToken(kind: IdentityTokenKind, token: string): Promise<boolean> {
    const now = new Date().toISOString();
    const row = await this.db.identityToken.findFirst({
      where: { tokenHash: hashToken(token), kind, consumedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * The Identity and Organization behind a live mailbox-proof token, without
   * consuming it. Used to resolve the Organization's password policy before
   * the single-use token is spent.
   */
  private async previewToken(
    kind: IdentityTokenKind,
    token: string,
  ): Promise<{ identityId: string; organizationId: string } | undefined> {
    const now = new Date().toISOString();
    const row = await this.db.identityToken.findFirst({
      where: { tokenHash: hashToken(token), kind, consumedAt: null, expiresAt: { gt: now } },
      select: {
        identityId: true,
        identity: { select: { organizationId: true } },
      },
    });
    if (!row) return undefined;
    return { identityId: row.identityId, organizationId: row.identity.organizationId };
  }

  /** Refuse a password the Organization's policy floors reject (ADR-0022). */
  private async assertPasswordPolicy(organizationId: string, password: string): Promise<void> {
    const problem = firstPasswordProblem(
      await this.settings.passwordPolicy(organizationId),
      password,
    );
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
      subject: `This email cannot be used — ${organizationName}`,
      body:
        `Someone tried to change an identity's email at ${organizationName} to this address, ` +
        `but this address is already in use or reserved for another identity.\n` +
        `No change was made — the address keeps its current holder.\n\n` +
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
