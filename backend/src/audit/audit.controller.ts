import {
  Controller,
  Get,
  Inject,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AdministratorGuard } from '../administrators/administrator.guard';
import type { AdministratorRequest } from '../administrators/administrators.controller';
import { DATABASE, Database } from '../storage/token';

export interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: unknown;
  occurredAt: string;
}

/** The unified audit surface (born in ticket 02, viewer matures in ticket 08). */
@Controller('api/audit')
@UseGuards(AdministratorGuard)
export class AuditController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  audit(@Req() req: AdministratorRequest): { events: AuditEventView[] } {
    const session = req.administratorSession;
    if (!session) throw new UnauthorizedException();
    const rows = this.db
      .prepare(
        'SELECT id, kind, actor, detail, occurred_at FROM audit_events WHERE organization_id = ? ORDER BY occurred_at DESC',
      )
      .all(session.organizationId) as Array<{
      id: string;
      kind: string;
      actor: string;
      detail: string;
      occurred_at: string;
    }>;
    return {
      events: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        actor: row.actor,
        detail: JSON.parse(row.detail),
        occurredAt: row.occurred_at,
      })),
    };
  }
}
