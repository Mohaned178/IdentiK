import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsString, MinLength } from 'class-validator';
import { AdministratorGuard } from '../administrators/administrator.guard';
import { OwnerGuard } from '../administrators/owner.guard';
import type { AdministratorRequest } from '../administrators/administrators.controller';
import { ApplicationsService, type ApplicationType, type ApplicationView, type SecretView } from './applications.service';

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
  constructor(private readonly applications: ApplicationsService) {}

  @Post()
  register(
    @Req() req: AdministratorRequest,
    @Body() body: RegisterApplicationBody,
  ): { application: ApplicationView; clientSecret: string | null } {
    const session = this.requireSession(req);
    if (body.type === 'web' && session.role !== 'owner') {
      throw new ForbiddenException(
        'registering a Web Application issues a Client Secret and is reserved to Owners',
      );
    }
    return this.applications.register({
      organizationId: session.organizationId,
      createdBy: session.administratorId,
      name: body.name,
      type: body.type,
    });
  }

  @Get()
  list(@Req() req: AdministratorRequest): { applications: ApplicationView[] } {
    const session = this.requireSession(req);
    return { applications: this.applications.list(session.organizationId) };
  }

  @Get(':id')
  find(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
  ): { application: ApplicationView } {
    const session = this.requireSession(req);
    return { application: this.applications.find(session.organizationId, id) };
  }

  @Post(':id/secrets')
  @UseGuards(OwnerGuard)
  issueSecret(
    @Req() req: AdministratorRequest,
    @Param('id') id: string,
    @Body() body: GenerateSecretBody,
  ): { secret: SecretView; clientSecret: string } {
    const session = this.requireSession(req);
    return this.applications.issueSecret({
      organizationId: session.organizationId,
      applicationId: id,
      createdBy: session.administratorId,
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
    const session = this.requireSession(req);
    return {
      secret: this.applications.revokeSecret({
        organizationId: session.organizationId,
        applicationId: id,
        secretId,
        actor: session.administratorId,
      }),
    };
  }

  private requireSession(req: AdministratorRequest) {
    const session = req.administratorSession;
    if (!session) throw new UnauthorizedException();
    return session;
  }
}
