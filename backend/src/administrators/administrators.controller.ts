import type { AdministratorSessionInfo } from './administrators.service';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AdministratorsService } from './administrators.service';
import { AdministratorGuard } from './administrator.guard';

class SignInBody {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
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
  constructor(private readonly administrators: AdministratorsService) {}

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
}
