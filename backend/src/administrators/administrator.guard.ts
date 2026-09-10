import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdministratorsService } from './administrators.service';
import { sessionTokenFrom, type AdministratorRequest } from './administrators.controller';

/** Guards Management API routes: only Administrator sessions pass. */
@Injectable()
export class AdministratorGuard implements CanActivate {
  constructor(private readonly administrators: AdministratorsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdministratorRequest>();
    const token = sessionTokenFrom(request);
    if (!token) throw new UnauthorizedException();
    const session = await this.administrators.resolveSession(token);
    if (!session) throw new UnauthorizedException();
    request.administratorSession = session;
    return true;
  }
}
