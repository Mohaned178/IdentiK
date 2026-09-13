import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsIn, IsString, MinLength } from 'class-validator';
import { AdministratorGuard } from '../administrators/administrator.guard';
import { assertOwner, OwnerGuard } from '../administrators/owner.guard';
import {
  requireAdministratorSession,
  type AdministratorRequest,
} from '../administrators/administrators.controller';
import {
  EnrollmentsService,
  type ApplicationEnrollmentView,
} from '../enrollments/enrollments.service';
import {
  ApplicationsService,
  type ApplicationType,
  type ApplicationView,
  type RedirectUriView,
  type SecretView,
} from './applications.service';

class RegisterApplicationBody {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(['web', 'spa'])
  type!: ApplicationType;
}

class GenerateSecretBody {
  @IsString()
  @MinLength(1)
  label!: string;
}

class RedirectUriBody {
  @IsString()
  @MinLength(1)
  uri!: string;
}

class ConfigureScopesBody {
  @IsArray()
  @IsString({ each: true })
  scopes!: string[];
}

/**
 * The Management API surface for Applications and their Client credentials
 * (ADR-0019). The dashboard is a client of exactly these routes. Registration
 * is Administrator-accessible; issuing and revoking Client Secrets is
 * Owner-only (ADR-0010/0016). A Web Application necessarily mints its first
 * secret at registration, so registering one is an Owner action too — a
 * Member registers SPA/Mobile Applications, which never hold a secret.
 */
@Controller('api/applications')
@UseGuards(AdministratorGuard)
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  @Post()
  async register(
    @Req() req: AdministratorRequest,
    @Body() body: RegisterApplicationBody,
  ): Promise<{ application: ApplicationView; clientSecret: string | null }> {
    const session = requireAdministratorSession(req);
    if (body.type === 'web') {
      assertOwner(
        session,
        'registering a Web Application issues a Client Secret and is reserved to Owners',
      );
    }
    return this.applications.register({
      organizationId: session.organizationId,
      actor: session.administratorId,
      name: body.name,
      type: body.type,
    });
  }

  @Get()
  async list(@Req() req: AdministratorRequest): Promise<{ applications: ApplicationView[] }> {
    const session = requireAdministratorSession(req);
    return { applications: await this.applications.list(session.organizationId) };
  }

  @Get(':id')
  async find(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ application: ApplicationView }> {
    const session = requireAdministratorSession(req);
    return { application: await this.applications.find(session.organizationId, id) };
  }

  /**
   * Disable: the reversible pause (ADR-0007). New authentication through the
   * Application is refused and its refresh tokens are revoked immediately;
   * Sessions survive. A routine state lever, available to Members (ADR-0008).
   */
  @Post(':id/disable')
  @HttpCode(200)
  async disable(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ application: ApplicationView }> {
    const session = requireAdministratorSession(req);
    return {
      application: await this.applications.disable({
        organizationId: session.organizationId,
        applicationId: id,
        actor: session.administratorId,
      }),
    };
  }

  @Post(':id/enable')
  @HttpCode(200)
  async enable(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): Promise<{ application: ApplicationView }> {
    const session = requireAdministratorSession(req);
    return {
      application: await this.applications.enable({
        organizationId: session.organizationId,
        applicationId: id,
        actor: session.administratorId,
      }),
    };
  }

  /**
   * Delete: Owner-only and irreversible (ADR-0007, ADR-0016). Enrollments are
   * removed and credentials revoked; Identities survive. There is no undo, so
   * the caller must send `{ confirm: true }`; without it the API states the
   * irreversibility plainly and refuses. The returned view is the
   * pseudonymous shell the audit trail remains attributed to.
   */
  @Delete(':id')
  @UseGuards(OwnerGuard)
  async delete(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: { confirm?: unknown },
  ): Promise<{ application: ApplicationView }> {
    const session = requireAdministratorSession(req);
    if (body?.confirm !== true) {
      throw new BadRequestException(
        'Deleting an Application is irreversible: it removes its Enrollments and revokes ' +
          'its credentials, and no path restores it. Resend with { "confirm": true } to proceed.',
      );
    }
    return {
      application: await this.applications.remove({
        organizationId: session.organizationId,
        applicationId: id,
        actor: session.administratorId,
      }),
    };
  }

  /**
   * The per-Application view (ADR-0008, ADR-0014): this Application's
   * Enrollments, and only its own.
   */
  @Get(':id/enrollments')
  enrollmentList(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): { enrollments: ApplicationEnrollmentView[] } {
    const session = requireAdministratorSession(req);
    return {
      enrollments: this.enrollments.listForApplication(session.organizationId, id),
    };
  }

  /** Suspend from Application: lose one Application, not the Organization. */
  @Post(':id/enrollments/:identityId/suspend')
  @HttpCode(200)
  suspendEnrollment(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('identityId') identityId: string,
  ): { enrollment: ApplicationEnrollmentView } {
    const session = requireAdministratorSession(req);
    return {
      enrollment: this.enrollments.suspendForApplication({
        organizationId: session.organizationId,
        applicationId: id,
        identityId,
        actor: session.administratorId,
      }),
    };
  }

  @Post(':id/enrollments/:identityId/unsuspend')
  @HttpCode(200)
  unsuspendEnrollment(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('identityId') identityId: string,
  ): { enrollment: ApplicationEnrollmentView } {
    const session = requireAdministratorSession(req);
    return {
      enrollment: this.enrollments.unsuspendForApplication({
        organizationId: session.organizationId,
        applicationId: id,
        identityId,
        actor: session.administratorId,
      }),
    };
  }

  @Post(':id/secrets')
  @UseGuards(OwnerGuard)
  async issueSecret(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: GenerateSecretBody,
  ): Promise<{ secret: SecretView; clientSecret: string }> {
    const session = requireAdministratorSession(req);
    return this.applications.issueSecret({
      organizationId: session.organizationId,
      applicationId: id,
      actor: session.administratorId,
      label: body.label,
    });
  }

  @Post(':id/secrets/:secretId/revoke')
  @HttpCode(200)
  @UseGuards(OwnerGuard)
  async revokeSecret(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('secretId') secretId: string,
  ): Promise<{ secret: SecretView }> {
    const session = requireAdministratorSession(req);
    return {
      secret: await this.applications.revokeSecret({
        organizationId: session.organizationId,
        applicationId: id,
        secretId,
        actor: session.administratorId,
      }),
    };
  }

  @Post(':id/redirect-uris')
  @UseGuards(OwnerGuard)
  async addRedirectUri(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: RedirectUriBody,
  ): Promise<{ redirectUri: RedirectUriView }> {
    const session = requireAdministratorSession(req);
    return {
      redirectUri: await this.applications.addRedirectUri({
        organizationId: session.organizationId,
        applicationId: id,
        actor: session.administratorId,
        uri: body.uri,
      }),
    };
  }

  @Patch(':id/redirect-uris/:uriId')
  @UseGuards(OwnerGuard)
  async updateRedirectUri(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('uriId') uriId: string,
    @Body() body: RedirectUriBody,
  ): Promise<{ redirectUri: RedirectUriView }> {
    const session = requireAdministratorSession(req);
    return {
      redirectUri: await this.applications.updateRedirectUri({
        organizationId: session.organizationId,
        applicationId: id,
        uriId,
        actor: session.administratorId,
        uri: body.uri,
      }),
    };
  }

  @Delete(':id/redirect-uris/:uriId')
  @UseGuards(OwnerGuard)
  async removeRedirectUri(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('uriId') uriId: string,
  ): Promise<{ redirectUri: RedirectUriView }> {
    const session = requireAdministratorSession(req);
    return {
      redirectUri: await this.applications.removeRedirectUri({
        organizationId: session.organizationId,
        applicationId: id,
        uriId,
        actor: session.administratorId,
      }),
    };
  }

  /**
   * Configure the scopes this Application may request (ADR-0016). Scope sets
   * govern token contents, not user-granted permissions; `openid` is always
   * required and the change is audit-logged. Members pull this lever with the
   * rest of integration state — it is neither destructive nor credential-
   * issuing.
   */
  @Put(':id/scopes')
  async configureScopes(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: ConfigureScopesBody,
  ): Promise<{ application: ApplicationView }> {
    const session = requireAdministratorSession(req);
    return {
      application: await this.applications.setScopes({
        organizationId: session.organizationId,
        applicationId: id,
        actor: session.administratorId,
        scopes: body.scopes,
      }),
    };
  }
}
