import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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
  async list(@Req() req: AdministratorRequest): Promise<{ identities: IdentityListItem[] }> {
    const session = requireAdministratorSession(req);
    return { identities: await this.directory.list(session.organizationId) };
  }

  @Get(':id')
  async detail(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ identity: IdentityDetail }> {
    const session = requireAdministratorSession(req);
    return { identity: await this.directory.detail(session.organizationId, id) };
  }

  /** Suspend Identity: block Organization-wide and kill every Session now. */
  @Post(':id/suspend')
  @HttpCode(200)
  async suspend(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ identity: IdentityDetail }> {
    const session = requireAdministratorSession(req);
    await this.identities.suspend({
      organizationId: session.organizationId,
      identityId: id,
      actor: session.administratorId,
    });
    return { identity: await this.directory.detail(session.organizationId, id) };
  }

  /** Unsuspend Identity: authentication returns; the killed Sessions do not. */
  @Post(':id/unsuspend')
  @HttpCode(200)
  async unsuspend(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ identity: IdentityDetail }> {
    const session = requireAdministratorSession(req);
    await this.identities.unsuspend({
      organizationId: session.organizationId,
      identityId: id,
      actor: session.administratorId,
    });
    return { identity: await this.directory.detail(session.organizationId, id) };
  }

  /** Revoke-all-Sessions: evict every device in one action. */
  @Post(':id/sessions/revoke-all')
  @HttpCode(200)
  async revokeAllSessions(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ revoked: number }> {
    const session = requireAdministratorSession(req);
    return {
      revoked: await this.identities.revokeAllSessions({
        organizationId: session.organizationId,
        identityId: id,
        actor: session.administratorId,
      }),
    };
  }

  /**
   * Force password reset: the mailbox gets the reset link and every Session
   * dies now. The Administrator never sets, reads, or sees a credential — the
   * Identity's own mailbox proves control and chooses the password (ADR-0008).
   */
  @Post(':id/force-password-reset')
  @HttpCode(200)
  async forcePasswordReset(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ status: 'reset-sent' }> {
    const session = requireAdministratorSession(req);
    await this.identities.forcePasswordReset({
      organizationId: session.organizationId,
      identityId: id,
      actor: session.administratorId,
    });
    return { status: 'reset-sent' };
  }

  /**
   * Anonymize an Identity — the irreversible "delete" (ADR-0007). There is no
   * undo, so the caller must send `{ confirm: true }`; without it the API
   * states the irreversibility plainly and refuses. The old email is freed for
   * a fresh, unlinked Identity, and the returned view is the pseudonymous
   * shell the audit trail remains attributed to. Members may pull this lever
   * with the rest of the state levers (ADR-0008).
   */
  @Post(':id/anonymize')
  @HttpCode(200)
  async anonymize(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: { confirm?: unknown },
  ): Promise<{ identity: IdentityDetail }> {
    const session = requireAdministratorSession(req);
    if (body?.confirm !== true) {
      throw new BadRequestException(
        'Anonymization is irreversible: it destroys the Identity\'s email, credentials, ' +
          'Sessions, and Enrollments, and no path restores it. Resend with { "confirm": true } ' +
          'to proceed.',
      );
    }
    await this.identities.anonymize({
      organizationId: session.organizationId,
      identityId: id,
      actor: session.administratorId,
    });
    return { identity: await this.directory.detail(session.organizationId, id) };
  }
}
