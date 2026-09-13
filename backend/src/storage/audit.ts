import type { DataAccess } from './data-access';
import { uuid } from '../bootstrap/uuid';

/**
 * The one way audit events are written (ADR-0023's unified audit surface):
 * every security-relevant action records who/what/when against its
 * Organization. Central here so the shape cannot drift between feature
 * modules. Accepts the top-level handle or a transaction client, so a write
 * inside a unit of work stays in it.
 */
export async function recordAuditEvent(
  db: DataAccess,
  event: {
    organizationId: string;
    actor: string;
    kind: string;
    detail: Record<string, unknown>;
    occurredAt?: string;
  },
): Promise<void> {
  await db.run(
    'INSERT INTO audit_events (id, organization_id, kind, actor, detail, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      uuid(),
      event.organizationId,
      event.kind,
      event.actor,
      JSON.stringify(event.detail),
      event.occurredAt ?? new Date().toISOString(),
    ],
  );
}
