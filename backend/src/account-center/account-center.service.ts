import { Inject, Injectable } from '@nestjs/common';
import type { ApplicationType } from '../applications/applications.service';
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
  currentSessionId: string;
  sessions: SessionView[];
  connectedApplications: ConnectedApplicationView[];
}

interface ConnectedApplicationRow {
  application_id: string;
  name: string;
  type: ApplicationType;
  created_at: string;
  suspended_at: string | null;
}

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
  ) {}

  view(session: SsoSession): AccountCenterView {
    return {
      organizationName: this.organizationName(session.organizationId),
      branding: this.settings.branding(session.organizationId),
      identity: { email: session.email },
      currentSessionId: session.id,
      sessions: this.sessions
        .listForIdentity(session.identityId)
        .map((entry) => ({ ...entry, current: entry.id === session.id })),
      connectedApplications: this.connectedApplications(session.identityId),
    };
  }

  private organizationName(organizationId: string): string {
    const row = this.db
      .prepare('SELECT name FROM organizations WHERE id = ?')
      .get(organizationId) as { name: string } | undefined;
    return row?.name ?? '';
  }

  private connectedApplications(identityId: string): ConnectedApplicationView[] {
    const rows = this.db
      .prepare(
        `SELECT e.application_id, a.name, a.type, e.created_at, e.suspended_at
         FROM enrollments e JOIN applications a ON a.id = e.application_id
         WHERE e.identity_id = ?
         ORDER BY e.created_at, e.id`,
      )
      .all(identityId) as unknown as ConnectedApplicationRow[];
    return rows.map((row) => ({
      applicationId: row.application_id,
      name: row.name,
      type: row.type,
      enrolledAt: row.created_at,
      suspended: row.suspended_at !== null,
    }));
  }
}
