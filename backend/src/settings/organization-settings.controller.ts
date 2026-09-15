import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdministratorGuard } from '../administrators/administrator.guard';
import { OwnerGuard } from '../administrators/owner.guard';
import {
  requireAdministratorSession,
  type AdministratorRequest,
} from '../administrators/administrators.controller';
import {
  OrganizationSettingsService,
  type OrganizationSettingsView,
} from './organization-settings.service';

/**
 * The Organization-scoped settings surface (ADR-0019, ADR-0022): the
 * dashboard edits branding, password policy, and session timeout here, and
 * every Administrator can read the effective values. Writing is Owner-only;
 * the trust fabric (SMTP, signing keys) is not addressable from this API at
 * all.
 */
@ApiTags('Organization')
@Controller('api/organization')
@UseGuards(AdministratorGuard)
export class OrganizationSettingsController {
  constructor(private readonly settings: OrganizationSettingsService) {}

  @Get('settings')
  async view(@Req() req: AdministratorRequest): Promise<OrganizationSettingsView> {
    const session = requireAdministratorSession(req);
    return this.settings.view(session.organizationId);
  }

  @Put('settings')
  @UseGuards(OwnerGuard)
  async update(
    @Req() req: AdministratorRequest,
    @Body() body: unknown,
  ): Promise<OrganizationSettingsView> {
    const session = requireAdministratorSession(req);
    return this.settings.update(session.organizationId, session.administratorId, body);
  }
}
