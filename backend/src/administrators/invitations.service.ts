import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { hashPassword, hashToken, randomToken } from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { LinkBaseService } from '../config/link-base.service';
import { normalizeEmail } from '../identities/email';
import { MailService } from '../mail/mail.service';
import { recordAuditEvent } from '../storage/audit';
import { isUniqueViolation } from '../storage/sqlite';
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

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: AdministratorRole;
  invited_by: string;
  expires_at: string;
  consumed_at: string | null;
  organization_name: string;
}

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
    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM administrators WHERE email = ?',
      [email],
    );
    if (existing) {
      throw new ConflictException('an administrator with this email already exists');
    }

    const organization = await this.db.get<{ name: string }>(
      'SELECT name FROM organizations WHERE id = ?',
      [input.organizationId],
    );
    if (!organization) throw new ConflictException('no such organization');

    const inviter = await this.db.get<{ name: string }>(
      'SELECT name FROM administrators WHERE id = ?',
      [input.invitedBy],
    );

    const invitationId = uuid();
    const token = randomToken(32);
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO administrator_invitations
           (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invitationId,
        input.organizationId,
        email,
        input.role,
        hashToken(token),
        input.invitedBy,
        new Date(Date.now() + this.invitationTtlMs()).toISOString(),
        now,
      ],
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
    const row = await this.findByToken(token);
    if (!row) {
      return { valid: false, organizationName: '', email: null, role: null };
    }
    const live = row.consumed_at === null && new Date(row.expires_at).getTime() > Date.now();
    if (!live && row.consumed_at === null) await this.auditExpiryOnce(row);
    return {
      valid: live,
      organizationName: row.organization_name,
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
    if (!invitation || invitation.consumed_at !== null) {
      return { ok: false, reason: 'invalid' };
    }
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      await this.auditExpiryOnce(invitation);
      return { ok: false, reason: 'expired' };
    }

    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM administrators WHERE email = ?',
      [invitation.email],
    );
    if (existing) return { ok: false, reason: 'invalid' };

    const passwordHash = await hashPassword(input.password);
    const administratorId = uuid();
    const membershipId = uuid();
    const now = new Date().toISOString();

    let consumed: boolean;
    try {
      consumed = await this.db.transaction(async (tx) => {
        const claimed = await tx.get<{ id: string }>(
          `UPDATE administrator_invitations SET consumed_at = ?
           WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
           RETURNING id`,
          [now, invitation.id, now],
        );
        if (!claimed) return false;

        await tx.run(
          'INSERT INTO administrators (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
          [administratorId, invitation.email, input.name, passwordHash, now],
        );
        await tx.run(
          'INSERT INTO memberships (id, organization_id, administrator_id, role) VALUES (?, ?, ?, ?)',
          [membershipId, invitation.organization_id, administratorId, invitation.role],
        );

        await recordAuditEvent(tx, {
          organizationId: invitation.organization_id,
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
      organizationId: invitation.organization_id,
      organizationName: invitation.organization_name,
      email: invitation.email,
      role: invitation.role,
    };
  }

  private async findByToken(token: string): Promise<InvitationRow | undefined> {
    return this.db.get<InvitationRow>(
      `SELECT i.id, i.organization_id, i.email, i.role, i.invited_by, i.expires_at,
                i.consumed_at, o.name AS organization_name
         FROM administrator_invitations i
         JOIN organizations o ON o.id = i.organization_id
         WHERE i.token_hash = ?`,
      [hashToken(token)],
    );
  }

  /**
   * Expiry has no scheduler, so it is recorded the first time a dead link is
   * presented (page load or accept). The guarded UPDATE makes "audit once"
   * race-free across both paths.
   */
  private async auditExpiryOnce(invitation: InvitationRow): Promise<void> {
    const now = new Date().toISOString();
    const marked = await this.db.run(
      `UPDATE administrator_invitations SET expiry_audited_at = ?
         WHERE id = ? AND expiry_audited_at IS NULL`,
      [now, invitation.id],
    );
    if (marked.rowCount !== 1) return;
    await recordAuditEvent(this.db, {
      organizationId: invitation.organization_id,
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
