import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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

/**
 * The unified audit surface (ADR-0020, ADR-0023). The dashboard viewer is a
 * client of exactly these reads: one Organization-scoped list, filterable by
 * actor, event kind, and time range. An Administrator actor is resolved to
 * the name and email the "who" question actually needs, while the raw actor
 * stays in the payload because it may be a non-human actor (`instance`,
 * `end-user`).
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  list(organizationId: string, filters: AuditFilters): AuditEventView[] {
    const actor = this.text(filters.actor, 'actor');
    const kind = this.text(filters.kind, 'kind');
    const from = this.instant(filters.from, 'from');
    const to = this.instant(filters.to, 'to');
    if (from && to && from > to) {
      throw new BadRequestException('from must not be after to');
    }

    const conditions = ['e.organization_id = ?'];
    const params: string[] = [organizationId];
    if (actor !== undefined) {
      conditions.push('e.actor = ?');
      params.push(actor);
    }
    if (kind !== undefined) {
      conditions.push('e.kind = ?');
      params.push(kind);
    }
    if (from !== undefined) {
      conditions.push('e.occurred_at >= ?');
      params.push(from);
    }
    if (to !== undefined) {
      conditions.push('e.occurred_at <= ?');
      params.push(to);
    }

    const rows = this.db
      .prepare(
        `SELECT e.id, e.kind, e.actor, e.detail, e.occurred_at,
                a.name AS actor_name, a.email AS actor_email
         FROM audit_events e
         LEFT JOIN administrators a ON a.id = e.actor
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
  private text(value: string | undefined, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new BadRequestException(`${name} must be a single value`);
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  /** Accept any parseable instant and compare in canonical ISO form. */
  private instant(value: string | undefined, name: string): string | undefined {
    const text = this.text(value, name);
    if (text === undefined) return undefined;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${name} must be an ISO-8601 instant`);
    }
    return parsed.toISOString();
  }
}
