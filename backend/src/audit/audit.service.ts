import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { optionalText } from '../common/text';
import { DATABASE, Database } from '../storage/token';

export interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  actorName: string | null;
  actorEmail: string | null;
  detail: unknown;
  occurredAt: string;
}

export interface AuditFilters {
  actor?: string;
  kind?: string;
  /** The Identity an event is about, as recorded in its detail (ADR-0008). */
  identityId?: string;
  from?: string;
  to?: string;
  /**
   * Internal cap for derived views (an Identity's recent activity); never an
   * HTTP filter, so the Management API's audit read stays complete.
   */
  limit?: number;
}

interface AuditEventRow {
  id: string;
  kind: string;
  actor: string;
  actor_name: string | null;
  actor_email: string | null;
  detail: string;
  occurred_at: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONED = /(Z|[+-]\d{2}:\d{2})$/i;

/**
 * The unified audit surface (ADR-0020, ADR-0023). The dashboard viewer is a
 * client of exactly these reads: one Organization-scoped list, filterable by
 * actor, event kind, and time range. An Administrator actor is resolved to
 * the name and email the "who" question actually needs, while the raw actor
 * stays in the payload because it may be a non-human actor (`instance`,
 * `end-user`). The actor itself is resolved only through a Membership in this
 * Organization, never through the global Administrator record.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(organizationId: string, filters: AuditFilters): Promise<AuditEventView[]> {
    const actor = optionalText(filters.actor);
    const kind = optionalText(filters.kind);
    const identityId = optionalText(filters.identityId);
    const from = this.instantFilter(filters.from, 'from');
    const to = this.instantFilter(filters.to, 'to');
    if (from && to && from > to) {
      throw new BadRequestException('from must not be after to');
    }

    const conditions = ['e.organization_id = ?'];
    const params: (string | number)[] = [organizationId];
    const add = (clause: string, value: string | undefined): void => {
      if (value === undefined) return;
      conditions.push(clause);
      params.push(value);
    };
    if (actor !== undefined) {
      // An Administrator can be named by id or by the email the surface
      // displays; the pseudo-actors match on their raw value.
      conditions.push('(e.actor = ? OR a.email = ?)');
      params.push(actor, actor);
    }
    add('e.kind = ?', kind);
    // Identity linkage lives in the event detail; the durable key is the
    // identityId, never the email (which anonymization destroys and reuse
    // recycles — ADR-0007).
    add("json_extract(e.detail, '$.identityId') = ?", identityId);
    add('e.occurred_at >= ?', from);
    add('e.occurred_at <= ?', to);
    if (filters.limit !== undefined) params.push(filters.limit);

    const rows = await this.db.all<AuditEventRow>(
      `SELECT e.id, e.kind, e.actor, e.detail, e.occurred_at,
              a.name AS actor_name, a.email AS actor_email
       FROM audit_events e
       LEFT JOIN memberships m
         ON m.organization_id = e.organization_id AND m.administrator_id = e.actor
       LEFT JOIN administrators a ON a.id = m.administrator_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.occurred_at DESC, e.rowid DESC
       ${filters.limit === undefined ? '' : 'LIMIT ?'}`,
      params,
    );

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      actor: row.actor,
      actorName: row.actor_name,
      actorEmail: row.actor_email,
      detail: JSON.parse(row.detail),
      occurredAt: row.occurred_at,
    }));
  }

  /**
   * Accept only instants with no ambiguity: an ISO date (UTC midnight) or an
   * ISO date-time carrying an explicit offset. An offsetless date-time would
   * parse in the server's local zone, so the same filter would select
   * different windows per deployment.
   */
  private instantFilter(value: string | undefined, name: string): string | undefined {
    const text = optionalText(value);
    if (text === undefined) return undefined;
    if (
      !isISO8601(text, { strict: true, strictSeparator: true }) ||
      (!DATE_ONLY.test(text) && !ZONED.test(text))
    ) {
      throw new BadRequestException(
        `${name} must be an ISO-8601 instant carrying a timezone (or a date)`,
      );
    }
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `${name} must be an ISO-8601 instant carrying a timezone (or a date)`,
      );
    }
    return parsed.toISOString();
  }
}
