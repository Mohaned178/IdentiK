import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { optionalText } from '../common/text';
import { Prisma } from '../generated/prisma/client';
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
  detail: unknown;
  occurred_at: Date;
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
 *
 * The list is one of the two deliberate raw-SQL exceptions (ADR-0027): the
 * actor join plus the JSONB identity filter over an optional limit is not
 * expressible (or not worth expressing) in typed Prisma. The statement is
 * built from parameterized fragments only, never interpolated values.
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

    const conditions: Prisma.Sql[] = [Prisma.sql`e.organization_id = ${organizationId}`];
    if (actor !== undefined) {
      // An Administrator can be named by id or by the email the surface
      // displays; the pseudo-actors match on their raw value.
      conditions.push(Prisma.sql`(e.actor = ${actor} OR a.email = ${actor})`);
    }
    if (kind !== undefined) conditions.push(Prisma.sql`e.kind = ${kind}`);
    // Identity linkage lives in the event detail; the durable key is the
    // identityId, never the email (which anonymization destroys and reuse
    // recycles — ADR-0007).
    if (identityId !== undefined) {
      conditions.push(Prisma.sql`(e.detail ->> 'identityId') = ${identityId}`);
    }
    if (from !== undefined) conditions.push(Prisma.sql`e.occurred_at >= ${from}`);
    if (to !== undefined) conditions.push(Prisma.sql`e.occurred_at <= ${to}`);

    // Deliberate raw-SQL exception (ADR-0027): the actor join, the JSONB
    // identity filter, and the optional limit are one dynamic query typed
    // reads cannot express. Every value is parameterized by the SQL tag.
    const rows = await this.db.$queryRaw<AuditEventRow[]>(Prisma.sql`
      SELECT e.id, e.kind, e.actor, e.detail, e.occurred_at,
             a.name AS actor_name, a.email AS actor_email
      FROM audit_events e
      LEFT JOIN memberships m
        ON m.organization_id = e.organization_id AND m.administrator_id = e.actor
      LEFT JOIN administrators a ON a.id = m.administrator_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY e.occurred_at DESC, e.seq DESC
      ${filters.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${filters.limit}`}
    `);

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      actor: row.actor,
      actorName: row.actor_name,
      actorEmail: row.actor_email,
      detail: row.detail,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }

  /**
   * Accept only instants with no ambiguity: an ISO date (UTC midnight) or an
   * ISO date-time carrying an explicit offset. An offsetless date-time would
   * parse in the server's local zone, so the same filter would select
   * different windows per deployment.
   */
  private instantFilter(value: string | undefined, name: string): Date | undefined {
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
    return parsed;
  }
}
