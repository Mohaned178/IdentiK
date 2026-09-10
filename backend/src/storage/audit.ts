import type { Database } from './token';
import { uuid } from '../bootstrap/uuid';

/**
 * The one way audit events are written (ADR-0023's unified audit surface):
 * every security-relevant action records who/what/when against its
 * Organization. Central here so the shape cannot drift between feature
 * modules.
 */
export function recordAuditEvent(
  db: Database,
  event: {
    organizationId: string;
    actor: string;
    kind: string;
    detail: Record<string, unknown>;
    occurredAt?: string;
  },
): void {
  db.prepare(
    'INSERT INTO audit_events (id, organization_id, kind, actor, detail, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    uuid(),
    event.organizationId,
    event.kind,
    event.actor,
    JSON.stringify(event.detail),
    event.occurredAt ?? new Date().toISOString(),
  );
}
