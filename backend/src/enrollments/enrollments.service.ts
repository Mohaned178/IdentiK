import { Inject, Injectable } from '@nestjs/common';
import { recordAuditEvent } from '../storage/audit';
import { isUniqueViolation } from '../storage/sqlite';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

export type EnrollmentGate =
  | { allowed: true; enrollmentId: string; created: boolean }
  | { allowed: false; reason: 'suspended' };

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
    const existing = this.db
      .prepare(
        'SELECT id, suspended_at FROM enrollments WHERE identity_id = ? AND application_id = ?',
      )
      .get(input.identityId, input.applicationId) as
      | { id: string; suspended_at: string | null }
      | undefined;

    if (existing) {
      if (existing.suspended_at !== null) return { allowed: false, reason: 'suspended' };
      return { allowed: true, enrollmentId: existing.id, created: false };
    }

    const id = uuid();
    try {
      this.db
        .prepare(
          'INSERT INTO enrollments (id, identity_id, application_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(id, input.identityId, input.applicationId, new Date().toISOString());
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = this.db
        .prepare(
          'SELECT id, suspended_at FROM enrollments WHERE identity_id = ? AND application_id = ?',
        )
        .get(input.identityId, input.applicationId) as
        | { id: string; suspended_at: string | null }
        | undefined;
      if (!raced) throw error;
      if (raced.suspended_at !== null) return { allowed: false, reason: 'suspended' };
      return { allowed: true, enrollmentId: raced.id, created: false };
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
    return { allowed: true, enrollmentId: id, created: true };
  }
}
