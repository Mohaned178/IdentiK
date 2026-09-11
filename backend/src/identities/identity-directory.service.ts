import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApplicationType } from '../applications/applications.service';
import { AuditService, type AuditEventView } from '../audit/audit.service';
import { SessionsService, type SessionSummary } from '../sessions/sessions.service';
import { DATABASE, Database } from '../storage/token';
import { anonymizedPseudonym, identityState, type IdentityState } from './identity-state';

export interface IdentityListItem {
  id: string;
  email: string;
  emailVerified: boolean;
  state: IdentityState;
  createdAt: string;
}

export interface IdentityEnrollmentView {
  applicationId: string;
  applicationName: string;
  applicationType: ApplicationType;
  enrolledAt: string;
  suspended: boolean;
}

export interface IdentityDetail extends IdentityListItem {
  enrollments: IdentityEnrollmentView[];
  sessions: SessionSummary[];
  recentActivity: AuditEventView[];
}

interface IdentityRow {
  id: string;
  email: string;
  email_verified: number;
  suspended_at: string | null;
  anonymized_at: string | null;
  created_at: string;
}

interface EnrollmentRow {
  application_id: string;
  application_name: string;
  application_type: ApplicationType;
  created_at: string;
  suspended_at: string | null;
}

/** How much authentication activity the detail view carries. */
const RECENT_ACTIVITY_LIMIT = 20;

/**
 * The Administrator's view of the Organization's people (ADR-0008, ADR-0019):
 * every Identity with its authentication state, and one Identity's full
 * security-relevant picture — Enrollments, active Sessions, and recent
 * authentication activity drawn from the unified audit surface. Everything
 * here is visibility; no lever and no credential lives on this service, and
 * every read is Organization-scoped by the caller's Administrator session.
 */
@Injectable()
export class IdentityDirectoryService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  list(organizationId: string): IdentityListItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, email, email_verified, suspended_at, anonymized_at, created_at
         FROM identities WHERE organization_id = ?
         ORDER BY created_at, id`,
      )
      .all(organizationId) as unknown as IdentityRow[];
    return rows.map((row) => this.toView(row));
  }

  detail(organizationId: string, identityId: string): IdentityDetail {
    const row = this.db
      .prepare(
        `SELECT id, email, email_verified, suspended_at, anonymized_at, created_at
         FROM identities WHERE id = ? AND organization_id = ?`,
      )
      .get(identityId, organizationId) as IdentityRow | undefined;
    if (!row) throw new NotFoundException('no such Identity');

    return {
      ...this.toView(row),
      enrollments: this.enrollments(row.id),
      sessions: this.sessions.listForIdentity(row.id),
      recentActivity: this.audit
        .list(organizationId, { identityId: row.id })
        .slice(0, RECENT_ACTIVITY_LIMIT),
    };
  }

  private enrollments(identityId: string): IdentityEnrollmentView[] {
    const rows = this.db
      .prepare(
        `SELECT e.application_id, a.name AS application_name, a.type AS application_type,
                e.created_at, e.suspended_at
         FROM enrollments e JOIN applications a ON a.id = e.application_id
         WHERE e.identity_id = ?
         ORDER BY e.created_at, e.id`,
      )
      .all(identityId) as unknown as EnrollmentRow[];
    return rows.map((row) => ({
      applicationId: row.application_id,
      applicationName: row.application_name,
      applicationType: row.application_type,
      enrolledAt: row.created_at,
      suspended: row.suspended_at !== null,
    }));
  }

  private toView(row: IdentityRow): IdentityListItem {
    const anonymized = row.anonymized_at !== null;
    return {
      id: row.id,
      // An anonymized Identity has no email left; the surviving shell is
      // displayed by its id-derived pseudonym (ADR-0007).
      email: anonymized ? anonymizedPseudonym(row.id) : row.email,
      emailVerified: row.email_verified === 1,
      state: identityState({
        emailVerified: row.email_verified === 1,
        suspended: row.suspended_at !== null,
        anonymized,
      }),
      createdAt: row.created_at,
    };
  }
}
