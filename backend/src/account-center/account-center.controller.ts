import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { sessionCookieOptions } from '../config/cookies';
import { LinkBaseService } from '../config/link-base.service';
import { EndUserSessionGuard, type EndUserRequest } from '../sessions/end-user.guard';
import { SSO_COOKIE, ssoTokenFrom } from '../sessions/sso-cookie';
import { SessionsService } from '../sessions/sessions.service';
import { AccountCenterService, AccountCenterView } from './account-center.service';

/**
 * The platform-hosted Account Center (ADR-0018): the End User's self-service
 * surface for their own device. Every route is scoped to the resolved SSO
 * Session's Identity — the request never names whose Sessions to touch.
 * Revoking a Session is the whole revocation story (ADR-0013): the cookie
 * dies, every descendant refresh token is revoked, and the event lands in the
 * audit surface. Revoking the current Session also clears the browser's
 * cookie, so it is indistinguishable from signing out.
 */
@Controller('api/account-center')
export class AccountCenterController {
  constructor(
    private readonly accountCenter: AccountCenterService,
    private readonly sessions: SessionsService,
    private readonly links: LinkBaseService,
  ) {}

  @Get()
  @UseGuards(EndUserSessionGuard)
  page(@Req() req: EndUserRequest): AccountCenterView {
    const session = req.endUserSession;
    if (!session) throw new UnauthorizedException();
    return this.accountCenter.view(session);
  }

  /**
   * Revoke one of the requesting Identity's own Sessions. A foreign or
   * unknown Session id is a 404: the caller learns nothing about other
   * people's devices. Idempotent by design — the second click changes
   * nothing and is not an error.
   */
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  @UseGuards(EndUserSessionGuard)
  revoke(
    @Req() req: EndUserRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): { status: 'revoked' } {
    const session = req.endUserSession;
    if (!session) throw new UnauthorizedException();
    const found = this.sessions.revoke({
      sessionId: id,
      identityId: session.identityId,
      reason: 'account_center',
    });
    if (!found) throw new NotFoundException('no such Session');
    if (id === session.id) this.clearCookie(res);
    return { status: 'revoked' };
  }

  /**
   * Sign-out is revocation of the current Session, nothing more mystical
   * (ADR-0013). Uniform whether or not a live Session was presented: the
   * cookie is cleared either way, so a stale cookie cannot linger.
   */
  @Post('sign-out')
  @HttpCode(204)
  signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
    const token = ssoTokenFrom(req);
    if (token) this.sessions.signOut(token);
    this.clearCookie(res);
  }

  private clearCookie(res: Response): void {
    res.clearCookie(SSO_COOKIE, sessionCookieOptions(this.links.resolve()));
  }
}
