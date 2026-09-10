import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AdministratorGuard } from '../administrators/administrator.guard';
import type { AdministratorRequest } from '../administrators/administrators.controller';
import { AuditEventView, AuditService } from './audit.service';

/**
 * The unified audit surface (ADR-0020, ADR-0023) — one Organization-scoped
 * list every Administrator can read, the dashboard included (ADR-0019).
 * Filters are optional and combine; nothing here is Owner-only, because
 * seeing the record is not a destructive act.
 */
@Controller('api/audit')
@UseGuards(AdministratorGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  events(
    @Req() req: AdministratorRequest,
    @Query('actor') actor?: string,
    @Query('kind') kind?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): { events: AuditEventView[] } {
    const session = req.administratorSession;
    if (!session) throw new UnauthorizedException();
    return { events: this.audit.list(session.organizationId, { actor, kind, from, to }) };
  }
}
