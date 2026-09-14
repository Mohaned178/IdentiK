import type { Prisma } from '../generated/prisma/client';
import { uuid } from '../bootstrap/uuid';

/**
 * The one way audit events are written (ADR-0023's unified audit surface):
 * every security-relevant action records who/what/when against its
 * Organization. Central here so the shape cannot drift between feature
 * modules. Accepts the injected client or an interactive transaction client,
 * so a write inside a unit of work stays in it. The detail is stored as native
 * JSONB and the instant as a native date.
 */
export async function recordAuditEvent(
  db: Prisma.TransactionClient,
  event: {
    organizationId: string;
    actor: string;
    kind: string;
    detail: Record<string, unknown>;
    occurredAt?: Date;
  },
): Promise<void> {
  await db.auditEvent.create({
    data: {
      id: uuid(),
      organizationId: event.organizationId,
      kind: event.kind,
      actor: event.actor,
      detail: event.detail as Prisma.InputJsonValue,
      occurredAt: event.occurredAt ?? new Date(),
    },
  });
}
