import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AdministratorSessionInfo } from './administrators.service';
import type { AdministratorRequest } from './administrators.controller';

/**
 * The Administrator Role split (ADR-0016): destructive or privilege-granting
 * actions are Owner-only. `assertOwner` is the one rule; the guard applies it
 * to whole routes, and controllers call it directly where the rule depends on
 * the request body (e.g. registering a Web Application mints a secret).
 */
export function assertOwner(
  session: AdministratorSessionInfo | undefined,
  message = 'this action is reserved to Owners',
): void {
  if (session?.role !== 'owner') throw new ForbiddenException(message);
}

@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdministratorRequest>();
    assertOwner(request.administratorSession);
    return true;
  }
}
