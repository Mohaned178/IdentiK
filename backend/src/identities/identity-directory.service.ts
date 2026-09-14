import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApplicationType } from '../applications/applications.service';
import { AuditService, type AuditEventView } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
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

/** The Identity fields the directory lists: never a credential (ADR-0008). */
const DIRECTORY_IDENTITY_SELECT = {
  id: true,
  email: true,
  emailVerified: true,
  suspendedAt: true,
  anonymizedAt: true,
  createdAt: true,
} as const;

type DirectoryIdentity = Prisma.IdentityGetPayload<{ select: typeof DIRECTORY_IDENTITY_SELECT }>;

/** The Application facts an Enrollment entry carries. */
const ENROLLMENT_WITH_APPLICATION = {
  application: { select: { name: true, type: true } },
} as const satisfies Prisma.EnrollmentInclude;

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

  async list(organizationId: string): Promise<IdentityListItem[]> {
    const rows = await this.db.identity.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: DIRECTORY_IDENTITY_SELECT,
    });
    return rows.map((row) => this.toView(row));
  }

  async detail(organizationId: string, identityId: string): Promise<IdentityDetail> {
    const row = await this.db.identity.findFirst({
      where: { id: identityId, organizationId },
      select: DIRECTORY_IDENTITY_SELECT,
    });
    if (!row) throw new NotFoundException('no such Identity');

    return {
      ...this.toView(row),
      enrollments: await this.enrollments(row.id),
      sessions: await this.sessions.listForIdentity(row.id),
      recentActivity: await this.audit.list(organizationId, {
        identityId: row.id,
        limit: RECENT_ACTIVITY_LIMIT,
      }),
    };
  }

  private async enrollments(identityId: string): Promise<IdentityEnrollmentView[]> {
    const rows = await this.db.enrollment.findMany({
      where: { identityId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: ENROLLMENT_WITH_APPLICATION,
    });
    return rows.map((row) => ({
      applicationId: row.applicationId,
      applicationName: row.application.name,
      applicationType: row.application.type,
      enrolledAt: row.createdAt.toISOString(),
      suspended: row.suspendedAt !== null,
    }));
  }

  private toView(row: DirectoryIdentity): IdentityListItem {
    const anonymized = row.anonymizedAt !== null;
    return {
      id: row.id,
      // An anonymized Identity has no email left; the surviving shell is
      // displayed by its id-derived pseudonym (ADR-0007).
      email: anonymized ? anonymizedPseudonym(row.id) : row.email,
      emailVerified: row.emailVerified,
      state: identityState({
        emailVerified: row.emailVerified,
        suspended: row.suspendedAt !== null,
        anonymized,
      }),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
