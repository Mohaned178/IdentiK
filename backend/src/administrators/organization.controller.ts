import { Controller, Get, Inject, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AdministratorGuard } from './administrator.guard';
import type { AdministratorRequest } from './administrators.controller';
import { DATABASE, Database } from '../storage/token';

/** The Management API's minimal Organization view for the dashboard shell. */
@Controller('api/organization')
@UseGuards(AdministratorGuard)
export class OrganizationController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  organization(@Req() req: AdministratorRequest): { id: string; name: string } {
    const session = req.administratorSession;
    if (!session) throw new UnauthorizedException();
    const row = this.db
      .prepare('SELECT id, name FROM organizations WHERE id = ?')
      .get(session.organizationId) as { id: string; name: string };
    return row;
  }
}
