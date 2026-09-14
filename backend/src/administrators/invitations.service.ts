import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { hashPassword } from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { LinkBaseService } from '../config/link-base.service';
import { normalizeEmail } from '../identities/email';
import { MailboxProofService } from '../mailbox-proof/mailbox-proof.service';
import { MailService } from '../mail/mail.service';
import { Prisma } from '../generated/prisma/client';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';
import type { AdministratorRole } from './administrators.service';

export interface InvitationInfo {
  valid: boolean;
  organizationName: string;
  email: string | null;
  role: AdministratorRole | null;
}

export type InvitationAcceptance =
  | {
      ok: true;
      administratorId: string;
      organizationId: string;
      organizationName: string;
      email: string;
      role: AdministratorRole;
    }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * The Administrator membership lifecycle (ADR-0021) obeying the rules the
 * platform sells: an Owner invites by email, the invitee sets their own
 * password (ADR-0008 applied to our own population), and the resulting
 * Membership is scoped to the Organization with an Administrator Role
 * (ADR-0016). Invitation links are single-use and expiring, stored
 * verifiable-only. There is no self-serve path to administration — the only
 * entry points are the Bootstrap Ceremony and a valid invitation.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly proofs: MailboxProofService,
    private readonly mail: MailService,
    private readonly links: LinkBaseService,
  ) {}

  /**
   * An Owner invites an email address to administer their Organization with a
   * given role. The invitation carries no credential: the invitee chooses
   * their own password when they accept.
   */
  async invite(input: {
    organizationId: string;
    invitedBy: string;
    email: string;
    role: AdministratorRole;
  }): Promise<{ invitationId: string; email: string; role: AdministratorRole }> {
    const email = normalizeEmail(input.email);
    if (await this.administratorExists(email)) {
      throw new ConflictException('an administrator with this email already exists');
    }

    const organization = await this.db.organization.findUnique({
      where: { id: input.organizationId },
      select: { name: true },
    });
    if (!organization) throw new ConflictException('no such organization');

    const inviter = await this.db.administrator.findUnique({
      where: { id: input.invitedBy },
      select: { name: true },
    });

    const { id: invitationId, token } = await this.proofs.issue(
      {
        kind: 'administrator_invitation',
        organizationId: input.organizationId,
        email,
        role: input.role,
        invitedBy: input.invitedBy,
      },
      this.invitationTtlMs(),
    );

    await recordAuditEvent(this.db, {
      organizationId: input.organizationId,
      actor: input.invitedBy,
      kind: 'administrator.invitation.issued',
      detail: {
        invitationId,
        email,
        role: input.role,
        invitedBy: input.invitedBy,
      },
    });

    await this.sendInvitationEmail({
      email,
      organizationName: organization.name,
      inviterName: inviter?.name,
      role: input.role,
      token,
    });

    return { invitationId, email, role: input.role };
  }

  /**
   * Whether an invitation link is live (exists, unconsumed, unexpired) and
   * which Organization's page it belongs to. The hosted acceptance page asks
   * this before drawing its form; it does not consume the token — only
   * accepting does. Presenting an expired link is the moment expiry becomes
   * observable, so it is audited here (once) as well as on a direct accept.
   */
  async inspect(token: string): Promise<InvitationInfo> {
    const peeked = await this.proofs.peek('administrator_invitation', token);
    if (peeked.status === 'invalid') {
      return { valid: false, organizationName: '', email: null, role: null };
    }
    const live = peeked.status === 'live';
    return {
      valid: live,
      organizationName: peeked.payload.organizationName,
      email: live ? peeked.payload.email : null,
      role: live ? peeked.payload.role : null,
    };
  }

  /**
   * Accepting an invitation: the invitee proves mailbox control by holding the
   * single-use link and sets their own password, creating the Administrator
   * and the Organization-scoped Membership with the invited role. Expiry is
   * detected here (there is no scheduler) and audited when the dead link is
   * presented. Failure never says more than "invalid".
   */
  async accept(input: {
    token: string;
    name: string;
    password: string;
  }): Promise<InvitationAcceptance> {
    const peeked = await this.proofs.peek('administrator_invitation', input.token);
    if (peeked.status === 'expired') return { ok: false, reason: 'expired' };
    if (peeked.status !== 'live') return { ok: false, reason: 'invalid' };

    if (await this.administratorExists(peeked.payload.email)) {
      return { ok: false, reason: 'invalid' };
    }

    const passwordHash = await hashPassword(input.password);
    const administratorId = uuid();
    const membershipId = uuid();
    const now = new Date();

    let consumed: boolean;
    try {
      consumed = await this.db.$transaction(async (tx) => {
        const claim = await this.proofs.consume('administrator_invitation', input.token, tx);
        if (claim.status !== 'claimed') return false;

        await tx.administrator.create({
          data: {
            id: administratorId,
            email: claim.payload.email,
            name: input.name,
            passwordHash,
            createdAt: now,
          },
        });
        await tx.membership.create({
          data: {
            id: membershipId,
            organizationId: claim.payload.organizationId,
            administratorId,
            role: claim.payload.role,
          },
        });

        await recordAuditEvent(tx, {
          organizationId: claim.payload.organizationId,
          actor: administratorId,
          kind: 'administrator.invitation.accepted',
          detail: {
            invitationId: claim.payload.id,
            administratorId,
            email: claim.payload.email,
            role: claim.payload.role,
          },
        });
        return true;
      });
    } catch (error) {
      // A lost email race surfaces as P2002 out of the rolled-back
      // transaction; the caller sees the same refusal as an unknown link. Never
      // caught inside the transaction: PostgreSQL aborts it after any failure
      // (ADR-0027).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { ok: false, reason: 'invalid' };
      }
      throw error;
    }
    if (!consumed) return { ok: false, reason: 'invalid' };

    return {
      ok: true,
      administratorId,
      organizationId: peeked.payload.organizationId,
      organizationName: peeked.payload.organizationName,
      email: peeked.payload.email,
      role: peeked.payload.role,
    };
  }

  /**
   * The invitee uniqueness check: the email must not already name an
   * Administrator. The unique constraint remains the race arbiter.
   */
  private async administratorExists(email: string): Promise<boolean> {
    const administrator = await this.db.administrator.findUnique({
      where: { email },
      select: { id: true },
    });
    return administrator !== null;
  }

  private async sendInvitationEmail(input: {
    email: string;
    organizationName: string;
    inviterName: string | undefined;
    role: AdministratorRole;
    token: string;
  }): Promise<void> {
    const link = `${this.links.resolve()}/administrators/accept-invitation?token=${encodeURIComponent(input.token)}`;
    const roleLabel = input.role === 'owner' ? 'Owner' : 'Member';
    const invitedBy = input.inviterName ? `${input.inviterName} invited you` : 'You have been invited';
    await this.mail.send({
      to: input.email,
      subject: `You are invited to administer ${input.organizationName} — IdentiK`,
      body:
        `${invitedBy} to administer ${input.organizationName} as a ${roleLabel}.\n\n` +
        `Choose your own password (nobody else sets it) by opening the link below:\n\n${link}\n\n` +
        `The link is single-use and expires soon. If you did not expect this invitation, you can ignore it.`,
    });
  }

  private invitationTtlMs(): number {
    return parseTtlMs('IDENTIK_INVITATION_TOKEN_TTL_MS', 7 * 24 * 60 * 60 * 1000);
  }
}
