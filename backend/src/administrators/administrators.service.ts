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
    const admin = this.db
      .prepare('SELECT id, password_hash FROM administrators WHERE email = ?')
      .get(normalized) as { id: string; password_hash: string } | undefined;

    // Verify even on unknown email so response timing does not reveal existence.
    const passwordOk = await verifyPassword(
      password,
      admin?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!admin || !passwordOk) {
      this.auditFailure(normalized, context.source);
      return { ok: false };
    }

    const membership = this.db
      .prepare(
        `SELECT m.id AS membership_id, m.role, o.id AS organization_id, o.name AS organization_name
         FROM memberships m JOIN organizations o ON o.id = m.organization_id
         WHERE m.administrator_id = ?`,
      )
      .get(admin.id) as {
      membership_id: string;
      role: string;
      organization_id: string;
      organization_name: string;
    } | undefined;
    if (!membership) {
      this.auditFailure(normalized, context.source);
      return { ok: false };
    }

    const token = randomToken(32);
    const now = new Date();
    const expires = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
    this.db
      .prepare(
        'INSERT INTO admin_sessions (id, membership_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        uuid(),
        membership.membership_id,
        await hashToken(token),
        now.toISOString(),
        expires.toISOString(),
      );

    return {
      ok: true,
      session: {
        token,
        membershipId: membership.membership_id,
        administratorId: admin.id,
        organizationId: membership.organization_id,
        organizationName: membership.organization_name,
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
  private auditFailure(email: string, source: string | null): void {
    const organizationId = this.failureOrganizationId(email);
    if (!organizationId) return;
    recordAuditEvent(this.db, {
      organizationId,
      actor: 'administrator',
      kind: 'administrator.sign_in.failed',
      detail: { email, reason: 'invalid_credentials', source },
    });
  }

  private failureOrganizationId(email: string): string | undefined {
    const member = this.db
      .prepare(
        `SELECT m.organization_id FROM administrators a
         JOIN memberships m ON m.administrator_id = a.id
         WHERE a.email = ?`,
      )
      .get(email) as { organization_id: string } | undefined;
    if (member) return member.organization_id;
    // Unknown email: there is exactly one Organization in this release, so
    // its surface is the honest home for the attempt until hosted mode exists.
    const hosted = this.db
      .prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1')
      .get() as { id: string } | undefined;
    return hosted?.id;
  }

  async resolveSession(token: string): Promise<AdministratorSessionInfo | null> {
    const row = this.db
      .prepare(
        `SELECT s.expires_at, s.revoked_at, m.id AS membership_id, m.role,
                m.organization_id, o.name AS organization_name, m.administrator_id
         FROM admin_sessions s
         JOIN memberships m ON m.id = s.membership_id
         JOIN organizations o ON o.id = m.organization_id
         WHERE s.token_hash = ?`,
      )
      .get(await hashToken(token)) as
      | {
          expires_at: string;
          revoked_at: string | null;
          membership_id: string;
          role: string;
          organization_id: string;
          organization_name: string;
          administrator_id: string;
        }
      | undefined;
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return {
      membershipId: row.membership_id,
      role: row.role as AdministratorRole,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      administratorId: row.administrator_id,
    };
  }

  async signOut(token: string): Promise<void> {
    this.db
      .prepare('UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), await hashToken(token));
  }
}
