import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { identityState, type IdentityState } from '../identities/identity-state';
import { recordAuditEvent } from '../storage/audit';
import { isUniqueViolation } from '../storage/sqlite';
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
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The first authentication through an Application creates its Enrollment;
   * later ones reuse it. A suspended Enrollment refuses — reversibly — and
   * never blocks the Identity's other Applications.
   */
  authorize(input: {
    organizationId: string;
    identityId: string;
    applicationId: string;
    email: string;
  }): EnrollmentGate {
    const existing = this.find(input.identityId, input.applicationId);
    if (existing) return this.gate(existing);

    try {
      this.db
        .prepare(
          'INSERT INTO enrollments (id, identity_id, application_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(uuid(), input.identityId, input.applicationId, new Date().toISOString());
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = this.find(input.identityId, input.applicationId);
      if (!raced) throw error;
      return this.gate(raced);
    }

    recordAuditEvent(this.db, {
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
  listForApplication(
    organizationId: string,
    applicationId: string,
  ): ApplicationEnrollmentView[] {
    const application = this.db
      .prepare('SELECT 1 FROM applications WHERE id = ? AND organization_id = ?')
      .get(applicationId, organizationId);
    if (!application) throw new NotFoundException('no such Application');

    const rows = this.db
      .prepare(
        `SELECT e.identity_id, e.created_at, e.suspended_at,
                i.email, i.email_verified, i.suspended_at AS identity_suspended_at
         FROM enrollments e JOIN identities i ON i.id = e.identity_id
         WHERE e.application_id = ? AND i.organization_id = ?
         ORDER BY e.created_at, e.id`,
      )
      .all(applicationId, organizationId) as unknown as ApplicationEnrollmentRow[];
    return rows.map((row) => ({
      identityId: row.identity_id,
      email: row.email,
      emailVerified: row.email_verified === 1,
      state: identityState({
        emailVerified: row.email_verified === 1,
        suspended: row.identity_suspended_at !== null,
      }),
      enrolledAt: row.created_at,
      suspended: row.suspended_at !== null,
    }));
  }

  private find(
    identityId: string,
    applicationId: string,
  ): { suspended_at: string | null } | undefined {
    return this.db
      .prepare('SELECT suspended_at FROM enrollments WHERE identity_id = ? AND application_id = ?')
      .get(identityId, applicationId) as { suspended_at: string | null } | undefined;
  }

  private gate(row: { suspended_at: string | null }): EnrollmentGate {
    return row.suspended_at === null ? { allowed: true } : { allowed: false, reason: 'suspended' };
  }
}
