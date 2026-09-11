import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdministratorGuard } from '../administrators/administrator.guard';
import {
  requireAdministratorSession,
  type AdministratorRequest,
} from '../administrators/administrators.controller';
import { IdentitiesService } from './identities.service';
import {
  IdentityDetail,
  IdentityDirectoryService,
  IdentityListItem,
} from './identity-directory.service';

/**
 * The Management API's Identity views and state levers (ADR-0006, ADR-0008,
 * ADR-0019): the directory every Administrator can read, the suspension and
 * session-revocation levers every Administrator can pull, and nothing that
 * sets or reveals a credential. The dashboard consumes exactly these routes —
 * there is no dashboard-only back door.
 */
@Controller('api/identities')
@UseGuards(AdministratorGuard)
export class IdentitiesController {
  constructor(
    private readonly directory: IdentityDirectoryService,
    private readonly identities: IdentitiesService,
  ) {}

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

  /** Suspend Identity: block Organization-wide and kill every Session now. */
  @Post(':id/suspend')
  @HttpCode(200)
  suspend(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): { identity: IdentityDetail } {
    const session = requireAdministratorSession(req);
    this.identities.suspend({
      organizationId: session.organizationId,
      identityId: id,
      actor: session.administratorId,
    });
    return { identity: this.directory.detail(session.organizationId, id) };
  }

  /** Unsuspend Identity: authentication returns; the killed Sessions do not. */
  @Post(':id/unsuspend')
  @HttpCode(200)
  unsuspend(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): { identity: IdentityDetail } {
    const session = requireAdministratorSession(req);
    this.identities.unsuspend({
      organizationId: session.organizationId,
      identityId: id,
      actor: session.administratorId,
    });
    return { identity: this.directory.detail(session.organizationId, id) };
  }

  /** Revoke-all-Sessions: evict every device in one action. */
  @Post(':id/sessions/revoke-all')
  @HttpCode(200)
  revokeAllSessions(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): { revoked: number } {
    const session = requireAdministratorSession(req);
    return {
      revoked: this.identities.revokeAllSessions({
        organizationId: session.organizationId,
        identityId: id,
        actor: session.administratorId,
      }),
    };
  }
}
