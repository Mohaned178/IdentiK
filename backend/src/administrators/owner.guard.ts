import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AdministratorRequest } from './administrators.controller';

/**
 * Enforces the Administrator Role split (ADR-0016): destructive or
 * privilege-granting actions are Owner-only. Runs after AdministratorGuard,
 * which has already established the session; a valid Member session is
 * authenticated but refused here.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdministratorRequest>();
    if (request.administratorSession?.role !== 'owner') {
      throw new ForbiddenException('this action is reserved to Owners');
    }
    return true;
  }
}
