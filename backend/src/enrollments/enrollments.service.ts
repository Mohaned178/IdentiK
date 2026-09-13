import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { identityState, type IdentityState } from '../identities/identity-state';
import { SessionsService } from '../sessions/sessions.service';
import { recordAuditEvent } from '../storage/audit';
import type { DataAccess } from '../storage/data-access';
import { isUniqueViolation } from '../storage/postgres';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

export type EnrollmentGate = { allowed: true } | { allowed: false; reason: 'suspended' };

/** One row of "this Application's people" (ADR-0008, ADR-0014). */
export interface ApplicationEnrollmentView {
  identityId: string;
  email: string;
  emailVerified: boolean;
  state: IdentityState;
  enrolledAt: string;
  suspended: boolean;
}

interface ApplicationEnrollmentRow {
  identity_id: string;
  email: string;
  email_verified: number;
  identity_suspended_at: string | null;
  identity_anonymized_at: string | null;
  created_at: string;
  suspended_at: string | null;
}

/**
 * An Enrollment is an Identity's membership in one Application, created
 * silently at first authentication — no consent screen (ADR-0014). The unique
 * (identity, application) pair is the arbiter; a suspended Enrollment refuses
 * authorization through that Application only (ADR-0006), which the
 * authorization endpoint gates before issuing a code.
 */
@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * The first authentication through an Application creates its Enrollment;
   * later ones reuse it. A suspended Enrollment refuses — reversibly — and
   * never blocks the Identity's other Applications.
   */
  async authorize(input: {
    organizationId: string;
    identityId: string;
    applicationId: string;
    email: string;
  }): Promise<EnrollmentGate> {
    const existing = await this.find(input.identityId, input.applicationId);
    if (existing) return this.gate(existing);

    try {
      await this.db.run(
        'INSERT INTO enrollments (id, identity_id, application_id, created_at) VALUES (?, ?, ?, ?)',
        [uuid(), input.identityId, input.applicationId, new Date().toISOString()],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.find(input.identityId, input.applicationId);
      if (!raced) throw error;
      return this.gate(raced);
    }

    await recordAuditEvent(this.db, {
      organizationId: input.organizationId,
      actor: 'end-user',
      kind: 'enrollment.created',
      detail: {
        identityId: input.identityId,
        applicationId: input.applicationId,
        email: input.email,
      },
    });
    return { allowed: true };
  }

  /**
   * Every Enrollment of one Application, Organization-scoped: "Zotac's
   * people" as a real list (ADR-0014). Identity state and enrollment state are
   * both present because they are independent levers (ADR-0006). The
   * Application must exist in this Organization first, so an unknown or
   * foreign id is a 404, never a misleading empty list.
   */
  async listForApplication(
    organizationId: string,
    applicationId: string,
  ): Promise<ApplicationEnrollmentView[]> {
    await this.requireApplication(organizationId, applicationId);

    const rows = await this.db.all<ApplicationEnrollmentRow>(
      `SELECT e.identity_id, e.created_at, e.suspended_at,
              i.email, i.email_verified, i.suspended_at AS identity_suspended_at,
              i.anonymized_at AS identity_anonymized_at
       FROM enrollments e JOIN identities i ON i.id = e.identity_id
       WHERE e.application_id = ? AND i.organization_id = ?
       ORDER BY e.created_at, e.id`,
      [applicationId, organizationId],
    );
    return rows.map((row) => this.toView(row));
  }

  /**
   * Remove every Enrollment of one Application (ADR-0007): irreversible
   * Application deletion takes the Application's Enrollments with it, while
   * the Identities themselves survive untouched. Takes the caller's client so
   * it can compose into their deletion transaction; returns how many
   * Enrollments were removed. There is no per-Enrollment audit event — the
   * deletion event records the collection effect.
   */
  async removeAllForApplication(db: DataAccess, applicationId: string): Promise<number> {
    const removed = await db.run('DELETE FROM enrollments WHERE application_id = ?', [
      applicationId,
    ]);
    return removed.rowCount;
  }

  /**
   * Suspend one Enrollment (ADR-0006): authentication through that Application
   * is refused, and the Identity's live platform Sessions are revoked in the
   * same action — an Identity marked suspended while still using the
   * Application for hours would be exactly the lie suspension exists to
   * prevent. The Identity's other Enrollments are untouched: this loses one
   * Application, not the Organization. Reversible via `unsuspendForApplication`.
   */
  async suspendForApplication(input: {
    organizationId: string;
    applicationId: string;
    identityId: string;
    actor: string;
  }): Promise<ApplicationEnrollmentView> {
    const current = await this.viewFor(input.organizationId, input.applicationId, input.identityId);
    if (!current.suspended) {
      await this.db.run(
        'UPDATE enrollments SET suspended_at = ? WHERE identity_id = ? AND application_id = ?',
        [new Date().toISOString(), input.identityId, input.applicationId],
      );
      await this.sessions.revokeAllForIdentity({
        identityId: input.identityId,
        organizationId: input.organizationId,
        reason: 'suspension',
        actor: input.actor,
      });
      await this.auditApplication(input, 'enrollment.suspended', current.email);
    }
    return this.viewFor(input.organizationId, input.applicationId, input.identityId);
  }

  /** Unsuspend one Enrollment, restoring authentication through it. */
  async unsuspendForApplication(input: {
    organizationId: string;
    applicationId: string;
    identityId: string;
    actor: string;
  }): Promise<ApplicationEnrollmentView> {
    const current = await this.viewFor(input.organizationId, input.applicationId, input.identityId);
    if (current.suspended) {
      await this.db.run(
        'UPDATE enrollments SET suspended_at = NULL WHERE identity_id = ? AND application_id = ?',
        [input.identityId, input.applicationId],
      );
      await this.auditApplication(input, 'enrollment.unsuspended', current.email);
    }
    return this.viewFor(input.organizationId, input.applicationId, input.identityId);
  }

  private async auditApplication(
    input: { organizationId: string; applicationId: string; identityId: string; actor: string },
    kind: 'enrollment.suspended' | 'enrollment.unsuspended',
    email: string,
  ): Promise<void> {
    await recordAuditEvent(this.db, {
      organizationId: input.organizationId,
      actor: input.actor,
      kind,
      detail: { identityId: input.identityId, applicationId: input.applicationId, email },
    });
  }

  /**
   * One Enrollment of a known Application and a known Identity, or 404. The
   * Application is checked first so an unknown Application never masquerades
   * as a missing Enrollment.
   */
  private async viewFor(
    organizationId: string,
    applicationId: string,
    identityId: string,
  ): Promise<ApplicationEnrollmentView> {
    await this.requireApplication(organizationId, applicationId);

    const row = await this.db.get<ApplicationEnrollmentRow>(
      `SELECT e.identity_id, e.created_at, e.suspended_at,
              i.email, i.email_verified, i.suspended_at AS identity_suspended_at,
              i.anonymized_at AS identity_anonymized_at
       FROM enrollments e JOIN identities i ON i.id = e.identity_id
       WHERE e.identity_id = ? AND e.application_id = ? AND i.organization_id = ?`,
      [identityId, applicationId, organizationId],
    );
    if (!row) throw new NotFoundException('no such Enrollment');
    return this.toView(row);
  }

  /** An unknown or foreign Application is a 404 from every path. */
  private async requireApplication(organizationId: string, applicationId: string): Promise<void> {
    const application = await this.db.get(
      'SELECT 1 FROM applications WHERE id = ? AND organization_id = ?',
      [applicationId, organizationId],
    );
    if (!application) throw new NotFoundException('no such Application');
  }

  private toView(row: ApplicationEnrollmentRow): ApplicationEnrollmentView {
    return {
      identityId: row.identity_id,
      email: row.email,
      emailVerified: row.email_verified === 1,
      state: identityState({
        emailVerified: row.email_verified === 1,
        suspended: row.identity_suspended_at !== null,
        anonymized: row.identity_anonymized_at !== null,
      }),
      enrolledAt: row.created_at,
      suspended: row.suspended_at !== null,
    };
  }

  /**
   * The same gate the authorization endpoint applies, asked again at the
   * token boundary: a suspended Enrollment must refuse an authorization-code
   * exchange or refresh even if a Session outlived the revocation cascade.
   * A missing Enrollment is not allowed — tokens are born of Enrollments
   * (ADR-0014), so absence is refusal, never a bypass.
   */
  async allows(identityId: string, applicationId: string): Promise<boolean> {
    const row = await this.find(identityId, applicationId);
    return row !== undefined && row.suspended_at === null;
  }

  private async find(
    identityId: string,
    applicationId: string,
  ): Promise<{ suspended_at: string | null } | undefined> {
    return this.db.get<{ suspended_at: string | null }>(
      'SELECT suspended_at FROM enrollments WHERE identity_id = ? AND application_id = ?',
      [identityId, applicationId],
    );
  }

  private gate(row: { suspended_at: string | null }): EnrollmentGate {
    return row.suspended_at === null ? { allowed: true } : { allowed: false, reason: 'suspended' };
  }
}
