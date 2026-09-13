import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AdministratorGuard } from '../administrators/administrator.guard';
import type { AdministratorRequest } from '../administrators/administrators.controller';
import { AuditEventView, AuditFilters, AuditService } from './audit.service';

class AuditQuery implements AuditFilters {
  @IsOptional()
  @IsString()
  actor?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

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
  async events(
    @Req() req: AdministratorRequest,
    @Query() query: AuditQuery,
  ): Promise<{ events: AuditEventView[] }> {
    const session = req.administratorSession;
    if (!session) throw new UnauthorizedException();
    return { events: await this.audit.list(session.organizationId, query) };
  }
}
