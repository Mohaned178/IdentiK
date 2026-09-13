import { Inject, Injectable } from '@nestjs/common';
import { DUMMY_PASSWORD_HASH, hashToken, randomToken, verifyPassword } from '../crypto/password';
import { normalizeEmail } from '../identities/email';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

export type AdministratorRole = 'owner' | 'member';

export interface AdministratorSessionInfo {
  membershipId: string;
  role: AdministratorRole;
  organizationId: string;
  organizationName: string;
  administratorId: string;
}

export interface AdministratorSignInResult {
  ok: boolean;
  session?: { token: string } & AdministratorSessionInfo;
}

export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The dedicated Administrator sign-in (ADR-0002): a separate population from
 * End Users, with its own credential store, session type, and flow. Sign-in
 * failure is uniform — unknown email and wrong password are indistinguishable.
 */
@Injectable()
export class AdministratorsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async signIn(
    email: string,
    password: string,
    context: { source: string | null },
  ): Promise<AdministratorSignInResult> {
    const normalized = normalizeEmail(email);
    const admin = await this.db.administrator.findUnique({
      where: { email: normalized },
      select: { id: true, passwordHash: true },
    });

    // Verify even on unknown email so response timing does not reveal existence.
    const passwordOk = await verifyPassword(
      password,
      admin?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!admin || !passwordOk) {
      await this.auditFailure(normalized, context.source);
      return { ok: false };
    }

    const membership = await this.db.membership.findFirst({
      where: { administratorId: admin.id },
      include: { organization: { select: { id: true, name: true } } },
    });
    if (!membership) {
      await this.auditFailure(normalized, context.source);
      return { ok: false };
    }

    const token = randomToken(32);
    const now = new Date();
    const expires = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
    await this.db.adminSession.create({
      data: {
        id: uuid(),
        membershipId: membership.id,
        tokenHash: await hashToken(token),
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
      },
    });

    return {
      ok: true,
      session: {
        token,
        membershipId: membership.id,
        administratorId: admin.id,
        organizationId: membership.organization.id,
        organizationName: membership.organization.name,
        role: membership.role as AdministratorRole,
      },
    };
  }

  /**
   * Failed Administrator sign-in attempts are security events (spec story 58,
   * ADR-0020): source and targeted email are recorded, uniformly for an
   * unknown email and a wrong password, so the audit trail carries no
   * existence signal either. The event lands in the targeted Administrator's
   * Organization; for an unknown email in a single-Organization Instance it
   * lands in that Organization, where the Owner actually reads the surface.
   */
  private async auditFailure(email: string, source: string | null): Promise<void> {
    const organizationId = await this.failureOrganizationId(email);
    if (!organizationId) return;
    await recordAuditEvent(this.db, {
      organizationId,
      actor: 'administrator',
      kind: 'administrator.sign_in.failed',
      detail: { email, reason: 'invalid_credentials', source },
    });
  }

  private async failureOrganizationId(email: string): Promise<string | undefined> {
    const membership = await this.db.membership.findFirst({
      where: { administrator: { email } },
      select: { organizationId: true },
    });
    if (membership) return membership.organizationId;
    // Unknown email: there is exactly one Organization in this release, so
    // its surface is the honest home for the attempt until hosted mode exists.
    const fallbackOrganization = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return fallbackOrganization?.id;
  }

  async resolveSession(token: string): Promise<AdministratorSessionInfo | null> {
    const row = await this.db.adminSession.findUnique({
      where: { tokenHash: await hashToken(token) },
      include: {
        membership: { include: { organization: { select: { name: true } } } },
      },
    });
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) return null;
    return {
      membershipId: row.membershipId,
      role: row.membership.role as AdministratorRole,
      organizationId: row.membership.organizationId,
      organizationName: row.membership.organization.name,
      administratorId: row.membership.administratorId,
    };
  }

  async signOut(token: string): Promise<void> {
    await this.db.adminSession.updateMany({
      where: { tokenHash: await hashToken(token) },
      data: { revokedAt: new Date().toISOString() },
    });
  }
}
