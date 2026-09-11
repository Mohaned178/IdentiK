import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AdministratorGuard } from '../administrators/administrator.guard';
import {
  requireAdministratorSession,
  type AdministratorRequest,
} from '../administrators/administrators.controller';
import {
  IdentityDetail,
  IdentityDirectoryService,
  IdentityListItem,
} from './identity-directory.service';

/**
 * The Management API's Identity views (ADR-0008, ADR-0019): the directory
 * every Administrator can read, scoped to the caller's Organization. The
 * dashboard consumes exactly these routes — there is no dashboard-only back
 * door, and there is no route here that sets anything that authenticates.
 */
@Controller('api/identities')
@UseGuards(AdministratorGuard)
export class IdentitiesController {
  constructor(private readonly directory: IdentityDirectoryService) {}

  @Get()
  list(@Req() req: AdministratorRequest): { identities: IdentityListItem[] } {
    const session = requireAdministratorSession(req);
    return { identities: this.directory.list(session.organizationId) };
  }

  @Get(':id')
  detail(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): { identity: IdentityDetail } {
    const session = requireAdministratorSession(req);
    return { identity: this.directory.detail(session.organizationId, id) };
  }
}
