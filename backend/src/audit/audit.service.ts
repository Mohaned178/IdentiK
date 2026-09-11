import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
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
  from?: string;
  to?: string;
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

  list(organizationId: string, filters: AuditFilters): AuditEventView[] {
    const actor = this.normalizeFilter(filters.actor);
    const kind = this.normalizeFilter(filters.kind);
    const from = this.instantFilter(filters.from, 'from');
    const to = this.instantFilter(filters.to, 'to');
    if (from && to && from > to) {
      throw new BadRequestException('from must not be after to');
    }

    const conditions = ['e.organization_id = ?'];
    const params: string[] = [organizationId];
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
    add('e.occurred_at >= ?', from);
    add('e.occurred_at <= ?', to);

    const rows = this.db
      .prepare(
        `SELECT e.id, e.kind, e.actor, e.detail, e.occurred_at,
                a.name AS actor_name, a.email AS actor_email
         FROM audit_events e
         LEFT JOIN memberships m
           ON m.organization_id = e.organization_id AND m.administrator_id = e.actor
         LEFT JOIN administrators a ON a.id = m.administrator_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY e.occurred_at DESC, e.rowid DESC`,
      )
      .all(...params) as unknown as AuditEventRow[];

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

  /** Empty values are treated as absent: a filter left blank is no filter. */
  private normalizeFilter(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  /**
   * Accept only instants with no ambiguity: an ISO date (UTC midnight) or an
   * ISO date-time carrying an explicit offset. An offsetless date-time would
   * parse in the server's local zone, so the same filter would select
   * different windows per deployment.
   */
  private instantFilter(value: string | undefined, name: string): string | undefined {
    const text = this.normalizeFilter(value);
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
