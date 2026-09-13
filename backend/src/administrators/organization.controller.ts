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
  async organization(@Req() req: AdministratorRequest): Promise<{ id: string; name: string }> {
    const session = req.administratorSession;
    if (!session) throw new UnauthorizedException();
    const row = await this.db.organization.findUnique({
      where: { id: session.organizationId },
      select: { id: true, name: true },
    });
    // The session's Membership references this Organization, so the row exists.
    return row!;
  }
}
