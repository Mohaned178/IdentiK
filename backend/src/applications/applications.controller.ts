import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsString, MinLength } from 'class-validator';
import { AdministratorGuard } from '../administrators/administrator.guard';
import { OwnerGuard } from '../administrators/owner.guard';
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
  register(
    @Req() req: AdministratorRequest,
    @Body() body: RegisterApplicationBody,
  ): { application: ApplicationView; clientSecret: string | null } {
    const session = requireAdministratorSession(req);
    if (body.type === 'web' && session.role !== 'owner') {
      throw new ForbiddenException(
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
  list(@Req() req: AdministratorRequest): { applications: ApplicationView[] } {
    const session = requireAdministratorSession(req);
    return { applications: this.applications.list(session.organizationId) };
  }

  @Get(':id')
  find(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): { application: ApplicationView } {
    const session = requireAdministratorSession(req);
    return { application: this.applications.find(session.organizationId, id) };
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
  issueSecret(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: GenerateSecretBody,
  ): { secret: SecretView; clientSecret: string } {
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
  revokeSecret(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('secretId') secretId: string,
  ): { secret: SecretView } {
    const session = requireAdministratorSession(req);
    return {
      secret: this.applications.revokeSecret({
        organizationId: session.organizationId,
        applicationId: id,
        secretId,
        actor: session.administratorId,
      }),
    };
  }

  @Post(':id/redirect-uris')
  @UseGuards(OwnerGuard)
  addRedirectUri(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: RedirectUriBody,
  ): { redirectUri: RedirectUriView } {
    const session = requireAdministratorSession(req);
    return {
      redirectUri: this.applications.addRedirectUri({
        organizationId: session.organizationId,
        applicationId: id,
        actor: session.administratorId,
        uri: body.uri,
      }),
    };
  }

  @Patch(':id/redirect-uris/:uriId')
  @UseGuards(OwnerGuard)
  updateRedirectUri(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('uriId') uriId: string,
    @Body() body: RedirectUriBody,
  ): { redirectUri: RedirectUriView } {
    const session = requireAdministratorSession(req);
    return {
      redirectUri: this.applications.updateRedirectUri({
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
  removeRedirectUri(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Param('uriId') uriId: string,
  ): { redirectUri: RedirectUriView } {
    const session = requireAdministratorSession(req);
    return {
      redirectUri: this.applications.removeRedirectUri({
        organizationId: session.organizationId,
        applicationId: id,
        uriId,
        actor: session.administratorId,
      }),
    };
  }
}
