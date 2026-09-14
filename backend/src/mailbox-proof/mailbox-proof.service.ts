import { Inject, Injectable } from '@nestjs/common';
import { hashToken, randomToken } from '../crypto/password';
import type { AdministratorRole, Prisma } from '../generated/prisma/client';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

/** The lifecycles that rest on proof of mailbox control (ADR-0011). */
export type MailboxProofKind =
  | 'email_verification'
  | 'password_reset'
  | 'email_change'
  | 'administrator_invitation';

export type MailboxProofRequest =
  | { kind: 'email_verification'; identityId: string }
  | { kind: 'password_reset'; identityId: string }
  | { kind: 'email_change'; identityId: string; organizationId: string; newEmail: string }
  | {
      kind: 'administrator_invitation';
      organizationId: string;
      email: string;
      role: AdministratorRole;
      invitedBy: string;
    };

/** What a live verification or password-reset proof proves. */
export interface IdentityProof {
  kind: 'email_verification' | 'password_reset';
  identityId: string;
  organizationId: string;
  email: string;
}

/** What a live email-change proof proves. */
export interface EmailChangeProof {
  kind: 'email_change';
  identityId: string;
  organizationId: string;
  newEmail: string;
}

/** What a live Administrator invitation proves. */
export interface InvitationProof {
  kind: 'administrator_invitation';
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: AdministratorRole;
}

export type MailboxProofPayload = IdentityProof | EmailChangeProof | InvitationProof;

/** A freshly minted proof: the raw value is visible exactly once. */
export interface MailboxProofIssued {
  id: string;
  token: string;
}

export type MailboxProofClaim<P extends MailboxProofPayload = MailboxProofPayload> =
  | { status: 'claimed'; payload: P }
  | { status: 'expired' }
  | { status: 'spent' }
  | { status: 'invalid' };

export type MailboxProofPeek<P extends MailboxProofPayload = MailboxProofPayload> =
  | { status: 'live'; payload: P }
  | { status: 'expired'; payload: P }
  | { status: 'spent'; payload: P }
  | { status: 'invalid' };

type ProofStatus = 'live' | 'expired' | 'spent';

function statusOf(row: { consumedAt: Date | null; expiresAt: Date }, now: Date): ProofStatus {
  if (row.consumedAt !== null) return 'spent';
  return row.expiresAt.getTime() > now.getTime() ? 'live' : 'expired';
}

/**
 * The mailbox-proof lifecycles (ADR-0011, ADR-0021): a single-use, expiring
 * value delivered to a mailbox, whose presentation proves control of that
 * mailbox. Verification, password reset, email change, and the Administrator
 * invitation all rest on it.
 *
 * Three verbs carry every flow. `issue` mints a proof and returns its raw
 * value exactly once; `consume` claims one and reports what it proved; `peek`
 * inspects without spending, for pages that must draw a form before the proof
 * is presented. The guarded claim — unconsumed and unexpired — is the
 * race-free single-use arbiter in one place: the subject is read in the same
 * statement that spends the proof, and a spent or expired proof reports what
 * it was, never what a caller hoped. The invitation's "expired, audited once"
 * mark and event live here too, so both the page and the acceptance path
 * share one rule.
 *
 * The module owns the proof, not its subject: credential state, handle
 * uniqueness, and the effects of a completed proof stay with callers. It
 * takes the injected data client (ADR-0027, never a repository) and accepts a
 * caller's transaction client, so a proof claimed inside a larger unit of
 * work stays in it.
 */
@Injectable()
export class MailboxProofService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Mint a proof for one subject. The raw token is returned once and stored
   * verifiable-only. A fresh email-change request supersedes the Identity's
   * previous pending one: at most one change is ever live (ADR-0005).
   */
  async issue(
    request: MailboxProofRequest,
    ttlMs: number,
    db: Prisma.TransactionClient = this.db,
  ): Promise<MailboxProofIssued> {
    const id = uuid();
    const token = randomToken(32);
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    switch (request.kind) {
      case 'email_verification':
      case 'password_reset':
        await db.identityToken.create({
          data: {
            id,
            identityId: request.identityId,
            kind: request.kind,
            tokenHash,
            expiresAt,
            createdAt: now,
          },
        });
        break;
      case 'email_change':
        await db.emailChangeRequest.deleteMany({
          where: { identityId: request.identityId, consumedAt: null },
        });
        await db.emailChangeRequest.create({
          data: {
            id,
            organizationId: request.organizationId,
            identityId: request.identityId,
            newEmail: request.newEmail,
            tokenHash,
            expiresAt,
            createdAt: now,
          },
        });
        break;
      case 'administrator_invitation':
        await db.administratorInvitation.create({
          data: {
            id,
            organizationId: request.organizationId,
            email: request.email,
            role: request.role,
            tokenHash,
            invitedBy: request.invitedBy,
            expiresAt,
            createdAt: now,
          },
        });
        break;
    }
    return { id, token };
  }

  /** Claim a live verification or password-reset proof. */
  async consume(
    kind: 'email_verification' | 'password_reset',
    token: string,
    db?: Prisma.TransactionClient,
  ): Promise<MailboxProofClaim<IdentityProof>>;
  /** Claim a live email-change proof. */
  async consume(
    kind: 'email_change',
    token: string,
    db?: Prisma.TransactionClient,
  ): Promise<MailboxProofClaim<EmailChangeProof>>;
  /** Claim a live Administrator invitation. */
  async consume(
    kind: 'administrator_invitation',
    token: string,
    db?: Prisma.TransactionClient,
  ): Promise<MailboxProofClaim<InvitationProof>>;
  async consume(
    kind: MailboxProofKind,
    token: string,
    db: Prisma.TransactionClient = this.db,
  ): Promise<MailboxProofClaim> {
    const now = new Date();
    const tokenHash = hashToken(token);

    if (kind === 'email_verification' || kind === 'password_reset') {
      const rows = await db.identityToken.updateManyAndReturn({
        where: { tokenHash, kind, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
        select: {
          identityId: true,
          identity: { select: { organizationId: true, email: true } },
        },
      });
      const row = rows[0];
      if (!row) return this.unclaimed(kind, token, db);
      return {
        status: 'claimed',
        payload: {
          kind,
          identityId: row.identityId,
          organizationId: row.identity.organizationId,
          email: row.identity.email,
        },
      };
    }

    if (kind === 'email_change') {
      const rows = await db.emailChangeRequest.updateManyAndReturn({
        where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
        select: { identityId: true, organizationId: true, newEmail: true },
      });
      const row = rows[0];
      if (!row) return this.unclaimed(kind, token, db);
      return {
        status: 'claimed',
        payload: {
          kind,
          identityId: row.identityId,
          organizationId: row.organizationId,
          newEmail: row.newEmail,
        },
      };
    }

    const rows = await db.administratorInvitation.updateManyAndReturn({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        organization: { select: { name: true } },
      },
    });
    const row = rows[0];
    if (!row) return this.unclaimed(kind, token, db);
    return {
      status: 'claimed',
      payload: {
        kind,
        id: row.id,
        organizationId: row.organizationId,
        organizationName: row.organization.name,
        email: row.email,
        role: row.role,
      },
    };
  }

  /** Inspect a verification or password-reset proof without consuming it. */
  async peek(
    kind: 'email_verification' | 'password_reset',
    token: string,
  ): Promise<MailboxProofPeek<IdentityProof>>;
  /** Inspect an email-change proof without consuming it. */
  async peek(kind: 'email_change', token: string): Promise<MailboxProofPeek<EmailChangeProof>>;
  /** Inspect an Administrator invitation without consuming it. */
  async peek(
    kind: 'administrator_invitation',
    token: string,
  ): Promise<MailboxProofPeek<InvitationProof>>;
  async peek(kind: MailboxProofKind, token: string): Promise<MailboxProofPeek> {
    return this.peekWith(kind, token, this.db);
  }

  /**
   * What a failed claim actually held: a spent proof, an expired one, or
   * nothing. Read only after a claim misses, and through the same client the
   * claim used, so a caller's transaction sees its own state.
   */
  private async unclaimed(
    kind: MailboxProofKind,
    token: string,
    db: Prisma.TransactionClient,
  ): Promise<MailboxProofClaim> {
    const peeked = await this.peekWith(kind, token, db);
    if (peeked.status === 'expired') return { status: 'expired' };
    if (peeked.status === 'spent') return { status: 'spent' };
    return { status: 'invalid' };
  }

  private async peekWith(
    kind: MailboxProofKind,
    token: string,
    db: Prisma.TransactionClient,
  ): Promise<MailboxProofPeek> {
    const now = new Date();
    const tokenHash = hashToken(token);

    if (kind === 'email_verification' || kind === 'password_reset') {
      const row = await db.identityToken.findFirst({
        where: { tokenHash, kind },
        select: {
          identityId: true,
          consumedAt: true,
          expiresAt: true,
          identity: { select: { organizationId: true, email: true } },
        },
      });
      if (!row) return { status: 'invalid' };
      return {
        status: statusOf(row, now),
        payload: {
          kind,
          identityId: row.identityId,
          organizationId: row.identity.organizationId,
          email: row.identity.email,
        },
      };
    }

    if (kind === 'email_change') {
      const row = await db.emailChangeRequest.findUnique({
        where: { tokenHash },
        select: {
          identityId: true,
          organizationId: true,
          newEmail: true,
          consumedAt: true,
          expiresAt: true,
        },
      });
      if (!row) return { status: 'invalid' };
      return {
        status: statusOf(row, now),
        payload: {
          kind,
          identityId: row.identityId,
          organizationId: row.organizationId,
          newEmail: row.newEmail,
        },
      };
    }

    const row = await db.administratorInvitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        consumedAt: true,
        expiresAt: true,
        organization: { select: { name: true } },
      },
    });
    if (!row) return { status: 'invalid' };
    const status = statusOf(row, now);
    if (status === 'expired') await this.auditExpiryOnce(db, row, now);
    return {
      status,
      payload: {
        kind: 'administrator_invitation',
        id: row.id,
        organizationId: row.organizationId,
        organizationName: row.organization.name,
        email: row.email,
        role: row.role,
      },
    };
  }

  /**
   * Expiry has no scheduler, so it is recorded the first time a dead link is
   * presented (page load or acceptance). The guarded UPDATE makes "audit
   * once" race-free across both paths (ADR-0021).
   */
  private async auditExpiryOnce(
    db: Prisma.TransactionClient,
    row: { id: string; organizationId: string; email: string },
    now: Date,
  ): Promise<void> {
    const marked = await db.administratorInvitation.updateMany({
      where: { id: row.id, expiryAuditedAt: null },
      data: { expiryAuditedAt: now },
    });
    if (marked.count !== 1) return;
    await recordAuditEvent(db, {
      organizationId: row.organizationId,
      actor: 'instance',
      kind: 'administrator.invitation.expired',
      detail: { invitationId: row.id, email: row.email },
      occurredAt: now,
    });
  }
}
