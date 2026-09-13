import type { DataHandle } from './data-access';
import { uuid } from '../bootstrap/uuid';

/**
 * The one way audit events are written (ADR-0023's unified audit surface):
 * every security-relevant action records who/what/when against its
 * Organization. Central here so the shape cannot drift between feature
 * modules. Accepts the injected client or a transaction handle, so a write
 * inside a unit of work stays in it. Typed since Stage 2's foundation; the
 * detail stays a JSON string until the native jsonb conversion.
 */
export async function recordAuditEvent(
  db: DataHandle,
  event: {
    organizationId: string;
    actor: string;
    kind: string;
    detail: Record<string, unknown>;
    occurredAt?: string;
  },
): Promise<void> {
  await db.auditEvent.create({
    data: {
      id: uuid(),
      organizationId: event.organizationId,
      kind: event.kind,
      actor: event.actor,
      detail: JSON.stringify(event.detail),
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    },
  });
}
