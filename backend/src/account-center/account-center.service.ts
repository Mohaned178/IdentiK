import { Inject, Injectable } from '@nestjs/common';
import type { ApplicationType } from '../applications/applications.service';
import type { Prisma } from '../generated/prisma/client';
import { IdentitiesService } from '../identities/identities.service';
import {
  OrganizationSettingsService,
  type Branding,
} from '../settings/organization-settings.service';
import {
  SessionsService,
  type SessionSummary,
  type SsoSession,
} from '../sessions/sessions.service';
import { DATABASE, Database } from '../storage/token';

export interface SessionView extends SessionSummary {
  current: boolean;
}

/** An Enrollment as the End User sees it: informational, never actionable. */
export interface ConnectedApplicationView {
  applicationId: string;
  name: string;
  type: ApplicationType;
  enrolledAt: string;
  suspended: boolean;
}

export interface AccountCenterView {
  organizationName: string;
  branding: Branding;
  identity: { email: string };
  pendingEmail: string | null;
  currentSessionId: string;
  sessions: SessionView[];
  connectedApplications: ConnectedApplicationView[];
}

/** The Application facts a connected-Application entry carries. */
const CONNECTED_APPLICATION = {
  application: { select: { name: true, type: true } },
} as const satisfies Prisma.EnrollmentInclude;

/**
 * The Account Center's data (ADR-0018): the End User's own Sessions, each
 * recognizable by device and last-seen time, and the Applications they are
 * enrolled in. The list is strictly informational (ADR-0014) — there is no
 * consent, no un-enroll, and no other Application action for an End User —
 * and it is scoped to the requesting Identity by construction: the view is
 * built from the resolved Session's Identity, never from a caller-supplied id.
 */
@Injectable()
export class AccountCenterService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionsService,
    private readonly settings: OrganizationSettingsService,
    private readonly identities: IdentitiesService,
  ) {}

  async view(session: SsoSession): Promise<AccountCenterView> {
    return {
      organizationName: await this.organizationName(session.organizationId),
      branding: await this.settings.branding(session.organizationId),
      identity: { email: session.email },
      pendingEmail: await this.identities.pendingEmailChange(session.identityId),
      currentSessionId: session.id,
      sessions: (await this.sessions.listForIdentity(session.identityId)).map((entry) => ({
        ...entry,
        current: entry.id === session.id,
      })),
      connectedApplications: await this.connectedApplications(session.identityId),
    };
  }

  private async organizationName(organizationId: string): Promise<string> {
    const row = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    return row?.name ?? '';
  }

  private async connectedApplications(identityId: string): Promise<ConnectedApplicationView[]> {
    const rows = await this.db.enrollment.findMany({
      where: { identityId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: CONNECTED_APPLICATION,
    });
    return rows.map((row) => ({
      applicationId: row.applicationId,
      name: row.application.name,
      type: row.application.type as ApplicationType,
      enrolledAt: row.createdAt,
      suspended: row.suspendedAt !== null,
    }));
  }
}
