import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { hashPassword, hashToken, randomToken } from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { LinkBaseService } from '../config/link-base.service';
import { normalizeEmail } from '../identities/email';
import { MailService } from '../mail/mail.service';
import type { Prisma } from '../generated/prisma/client';
import { recordAuditEvent } from '../storage/audit';
import { isUniqueViolation } from '../storage/postgres';
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

const INVITATION_WITH_ORGANIZATION = {
  organization: { select: { name: true } },
} satisfies Prisma.AdministratorInvitationInclude;

type InvitationWithOrganization = Prisma.AdministratorInvitationGetPayload<{
  include: typeof INVITATION_WITH_ORGANIZATION;
}>;

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

    const invitationId = uuid();
    const token = randomToken(32);
    const now = new Date();
    await this.db.administratorInvitation.create({
      data: {
        id: invitationId,
        organizationId: input.organizationId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: input.invitedBy,
        expiresAt: new Date(Date.now() + this.invitationTtlMs()),
        createdAt: now,
      },
    });

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
    const row = await this.findByToken(token);
    if (!row) {
      return { valid: false, organizationName: '', email: null, role: null };
    }
    const live = row.consumedAt === null && row.expiresAt.getTime() > Date.now();
    if (!live && row.consumedAt === null) await this.auditExpiryOnce(row);
    return {
      valid: live,
      organizationName: row.organization.name,
      email: live ? row.email : null,
      role: live ? row.role : null,
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
    const invitation = await this.findByToken(input.token);
    if (!invitation || invitation.consumedAt !== null) {
      return { ok: false, reason: 'invalid' };
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await this.auditExpiryOnce(invitation);
      return { ok: false, reason: 'expired' };
    }

    if (await this.administratorExists(invitation.email)) {
      return { ok: false, reason: 'invalid' };
    }

    const passwordHash = await hashPassword(input.password);
    const administratorId = uuid();
    const membershipId = uuid();
    const now = new Date();

    let consumed: boolean;
    try {
      consumed = await this.db.transaction(async (tx) => {
        const claimed = await tx.administratorInvitation.updateMany({
          where: { id: invitation.id, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (claimed.count !== 1) return false;

        await tx.administrator.create({
          data: {
            id: administratorId,
            email: invitation.email,
            name: input.name,
            passwordHash,
            createdAt: now,
          },
        });
        await tx.membership.create({
          data: {
            id: membershipId,
            organizationId: invitation.organizationId,
            administratorId,
            role: invitation.role,
          },
        });

        await recordAuditEvent(tx, {
          organizationId: invitation.organizationId,
          actor: administratorId,
          kind: 'administrator.invitation.accepted',
          detail: {
            invitationId: invitation.id,
            administratorId,
            email: invitation.email,
            role: invitation.role,
          },
        });
        return true;
      });
    } catch (error) {
      // A lost email race surfaces as a unique violation out of the rolled-back
      // transaction; the caller sees the same refusal as an unknown link.
      if (isUniqueViolation(error)) return { ok: false, reason: 'invalid' };
      throw error;
    }
    if (!consumed) return { ok: false, reason: 'invalid' };

    return {
      ok: true,
      administratorId,
      organizationId: invitation.organizationId,
      organizationName: invitation.organization.name,
      email: invitation.email,
      role: invitation.role,
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

  private async findByToken(token: string): Promise<InvitationWithOrganization | null> {
    return this.db.administratorInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: INVITATION_WITH_ORGANIZATION,
    });
  }

  /**
   * Expiry has no scheduler, so it is recorded the first time a dead link is
   * presented (page load or accept). The guarded UPDATE makes "audit once"
   * race-free across both paths.
   */
  private async auditExpiryOnce(invitation: InvitationWithOrganization): Promise<void> {
    const now = new Date();
    const marked = await this.db.administratorInvitation.updateMany({
      where: { id: invitation.id, expiryAuditedAt: null },
      data: { expiryAuditedAt: now },
    });
    if (marked.count !== 1) return;
    await recordAuditEvent(this.db, {
      organizationId: invitation.organizationId,
      actor: 'instance',
      kind: 'administrator.invitation.expired',
      detail: { invitationId: invitation.id, email: invitation.email },
      occurredAt: now,
    });
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
