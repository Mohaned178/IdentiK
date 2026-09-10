import type { AdministratorRole, AdministratorSessionInfo } from './administrators.service';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { AdministratorsService } from './administrators.service';
import { AdministratorGuard } from './administrator.guard';
import { OwnerGuard } from './owner.guard';
import { InvitationsService } from './invitations.service';

class SignInBody {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

class InviteAdministratorBody {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsIn(['owner', 'member'])
  role?: AdministratorRole;
}

class AcceptInvitationBody {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export const SESSION_COOKIE = 'identik_admin_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface AdministratorRequest extends Request {
  administratorSession?: AdministratorSessionInfo;
}

export function sessionTokenFrom(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

@Controller('api/administrators')
export class AdministratorsController {
  constructor(
    private readonly administrators: AdministratorsService,
    private readonly invitations: InvitationsService,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  async signIn(@Body() body: SignInBody, @Res({ passthrough: true }) res: Response) {
    const result = await this.administrators.signIn(body.email, body.password);
    if (!result.ok || !result.session) {
      throw new UnauthorizedException();
    }
    res.cookie(SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });
    return {
      administratorId: result.session.administratorId,
      organizationName: result.session.organizationName,
      role: result.session.role,
    };
  }

  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = sessionTokenFrom(req);
    if (token) {
      await this.administrators.signOut(token);
    }
    res.clearCookie(SESSION_COOKIE);
  }

  @Get('session')
  @UseGuards(AdministratorGuard)
  session(@Req() req: AdministratorRequest): AdministratorSessionInfo {
    if (!req.administratorSession) throw new UnauthorizedException();
    return req.administratorSession;
  }

  /**
   * Owner-only (ADR-0016/0021): an Owner invites an Administrator by email.
   * The request carries a role but never a credential — the invitee sets their
   * own password through the invitation link.
   */
  @Post('invitations')
  @UseGuards(AdministratorGuard, OwnerGuard)
  invite(
    @Req() req: AdministratorRequest,
    @Body() body: InviteAdministratorBody,
  ): Promise<{ invitationId: string; email: string; role: AdministratorRole }> {
    const session = req.administratorSession;
    if (!session) throw new UnauthorizedException();
    return this.invitations.invite({
      organizationId: session.organizationId,
      invitedBy: session.administratorId,
      email: body.email,
      role: body.role ?? 'member',
    });
  }

  /**
   * The hosted acceptance page's data: is this invitation link live, and which
   * Organization does it belong to? Never consumes the token — only accepting
   * does.
   */
  @Get('invitations')
  invitationInfo(@Query('token') token: string | undefined): {
    organizationName: string;
    valid: boolean;
    email: string | null;
    role: AdministratorRole | null;
  } {
    if (typeof token !== 'string' || token.length === 0) {
      return this.invitations.inspect('');
    }
    return this.invitations.inspect(token);
  }

  /**
   * Accepting an invitation: the invitee sets their own password and receives
   * the Organization-scoped Membership with the invited role. The only failure
   * is a dead (invalid, consumed, or expired) link, so nothing is hidden by
   * broadening the message.
   */
  @Post('invitations/accept')
  async acceptInvitation(@Body() body: AcceptInvitationBody): Promise<{
    administratorId: string;
    organizationName: string;
    email: string;
    role: AdministratorRole;
  }> {
    const result = await this.invitations.accept(body);
    if (!result.ok) throw new BadRequestException('this invitation link is invalid or has expired');
    return {
      administratorId: result.administratorId,
      organizationName: result.organizationName,
      email: result.email,
      role: result.role,
    };
  }
}
