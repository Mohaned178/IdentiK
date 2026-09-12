import {
  Body,
  Controller,
  ForbiddenException,
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
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { sessionCookieOptions } from '../config/cookies';
import { LinkBaseService } from '../config/link-base.service';
import { IdentitiesService } from '../identities/identities.service';
import { EndUserSessionGuard, type EndUserRequest } from '../sessions/end-user.guard';
import { SSO_COOKIE, ssoTokenFrom } from '../sessions/sso-cookie';
import { SessionsService } from '../sessions/sessions.service';
import { ThrottleService, type ThrottleSubject } from '../throttle/throttle.service';
import { AccountCenterService, AccountCenterView } from './account-center.service';

class ChangePasswordBody {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

class ChangeEmailBody {
  @IsEmail()
  newEmail!: string;
}

/**
 * The platform-hosted Account Center (ADR-0018): the End User's self-service
 * surface for their own device. Every route is scoped to the resolved SSO
 * Session's Identity — the request never names whose Sessions to touch.
 * Revoking a Session is the whole revocation story (ADR-0013): the cookie
 * dies, every descendant refresh token is revoked, and the event lands in the
 * audit surface. Revoking the current Session also clears the browser's
 * cookie, so it is indistinguishable from signing out. Password change is the
 * same story with one exception: the Session where the change happens
 * survives (ADR-0013).
 */
@Controller('api/account-center')
export class AccountCenterController {
  constructor(
    private readonly accountCenter: AccountCenterService,
    private readonly identities: IdentitiesService,
    private readonly sessions: SessionsService,
    private readonly links: LinkBaseService,
    private readonly throttle: ThrottleService,
  ) {}

  @Get()
  @UseGuards(EndUserSessionGuard)
  page(@Req() req: EndUserRequest): AccountCenterView {
    const session = req.endUserSession;
    if (!session) throw new UnauthorizedException();
    return this.accountCenter.view(session);
  }

  /**
   * Change the requesting Identity's own password (ADR-0008, ADR-0013): the
   * current credential proves the change is the owner's, the device that
   * changed it stays signed in, and every other device is evicted with its
   * refresh lineage. A wrong current password is a clean 403 and changes
   * nothing.
   */
  @Post('password')
  @HttpCode(200)
  @UseGuards(EndUserSessionGuard)
  async changePassword(
    @Req() req: EndUserRequest,
    @Body() body: ChangePasswordBody,
  ): Promise<{ status: 'password-changed' }> {
    const session = req.endUserSession;
    if (!session) throw new UnauthorizedException();
    const changed = await this.identities.changePassword({
      identityId: session.identityId,
      currentSessionId: session.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    if (!changed) throw new ForbiddenException('the current password is incorrect');
    return { status: 'password-changed' };
  }

  /**
   * Request an email change (ADR-0008, ADR-0018). The response is uniform
   * (ADR-0005): whether the new address is free or already claimed, the caller
   * sees the same shape; the verification link — or the refusal — travels to
   * the requested mailbox, never the HTTP layer. The Identity's handle is
   * untouched until the link is clicked.
   */
  @Post('email')
  @HttpCode(202)
  @UseGuards(EndUserSessionGuard)
  async changeEmail(
    @Req() req: EndUserRequest,
    @Body() body: ChangeEmailBody,
  ): Promise<{ status: 'check-your-mailbox' }> {
    const session = req.endUserSession;
    if (!session) throw new UnauthorizedException();
    // Sending mail to an arbitrary address is a public-facing abuse surface,
    // so the request carries the same escalating per-source/per-Identity delay
    // as sign-up and forgot-password (ADR-0020). Keyed on the requesting
    // Identity, never the requested address, so the delay cannot distinguish
    // which addresses are already claimed.
    const subject: ThrottleSubject = { source: req.ip ?? null, identity: session.email };
    await this.throttle.wait('email-change', subject);
    this.throttle.record('email-change', subject);
    await this.identities.requestEmailChange({
      identityId: session.identityId,
      newEmail: body.newEmail,
    });
    return { status: 'check-your-mailbox' };
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
