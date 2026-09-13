import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ssoTokenFrom } from './sso-cookie';
import { SessionsService, type SsoSession } from './sessions.service';

export interface EndUserRequest extends Request {
  endUserSession?: SsoSession;
}

/**
 * Guards End-User self-service routes: only a live SSO Session passes. The
 * resolution is the same fail-closed gate as everywhere else, so a revoked,
 * expired, suspended, or password-reset Session is simply not signed in.
 */
@Injectable()
export class EndUserSessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<EndUserRequest>();
    const token = ssoTokenFrom(request);
    if (!token) throw new UnauthorizedException();
    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthorizedException();
    request.endUserSession = session;
    return true;
  }
}
