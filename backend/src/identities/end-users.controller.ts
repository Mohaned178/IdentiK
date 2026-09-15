import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  Body,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ThrottleService, type ThrottleScope, type ThrottleSubject } from '../throttle/throttle.service';
import {
  OrganizationSettingsService,
  type Branding,
} from '../settings/organization-settings.service';
import { normalizeEmail } from './email';
import { IdentitiesService } from './identities.service';

class SignUpBody {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class ForgotPasswordBody {
  @IsEmail()
  email!: string;
}

class ResetPasswordBody {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

/**
 * The hosted End-User sign-up boundary. GET is the hosted page's data (the
 * page carries the Organization's name — full branding arrives with ticket
 * 18); POST is the form's target. The POST response is deliberately uniform
 * (ADR-0005/0011): whatever happened, the visitor sees the same status,
 * shape, and timing — the accepted/refused distinction travels to the
 * mailbox, never the HTTP layer.
 */
@ApiTags('End users')
@Controller('api/end-users')
export class EndUsersController {
  private readonly logger = new Logger(EndUsersController.name);

  constructor(
    private readonly identities: IdentitiesService,
    private readonly throttle: ThrottleService,
    private readonly settings: OrganizationSettingsService,
  ) {}

  @Get('sign-up')
  signUpPageInfo(): Promise<{ organizationName: string; branding: Branding }> {
    return this.pageInfo();
  }

  @Post('sign-up')
  @HttpCode(201)
  async signUp(
    @Req() req: Request,
    @Body() body: SignUpBody,
  ): Promise<{ status: 'check-your-mailbox' }> {
    await this.guardAttempt('sign-up', req, body.email);
    await this.identities.signUp(body);
    return { status: 'check-your-mailbox' };
  }

  /**
   * The verification click. This route exists to be opened from a mail
   * client, so it redirects (302) to the hosted result page; the outcome
   * lives in the redirect, and the SPA renders it.
   */
  @Get('verify-email')
  async verifyEmail(
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Refuse without a token synchronously: redirect-with-empty-string below
    // would otherwise construct a URL ending in "token=".
    if (typeof token !== 'string' || token.length === 0) {
      res.redirect(302, this.resultPath('invalid'));
      return;
    }
    try {
      const verified = await this.identities.verifyEmail(token);
      res.redirect(302, this.resultPath(verified ? 'verified' : 'invalid'));
    } catch (error) {
      // A dead link and a failed write both answer "invalid" so nothing is
      // revealed at the surface; the failure itself still needs to be
      // diagnosable from the Instance log.
      this.logger.error(
        `email verification click failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.redirect(302, this.resultPath('invalid'));
    }
  }

  /** Shape-checked outcome for the hosted result page, branded like the rest. */
  @Get('verify-email/result')
  async resultPageInfo(
    @Query('outcome') outcome: string | undefined,
  ): Promise<{ outcome: string; organizationName: string; branding: Branding }> {
    if (outcome === 'verified' || outcome === 'invalid') {
      return { outcome, ...(await this.pageInfo()) };
    }
    throw new BadRequestException('outcome must be "verified" or "invalid"');
  }

  /**
   * The email-change verification click (ADR-0008, ADR-0018): proof of the new
   * mailbox, opened from a mail client with no Session required. Like the
   * sign-up verification click, it redirects to a hosted result page; the
   * change is applied by the service only when the single-use link is live.
   */
  @Get('change-email')
  async changeEmail(
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (typeof token !== 'string' || token.length === 0) {
      res.redirect(302, this.changeEmailResultPath('invalid'));
      return;
    }
    try {
      const changed = await this.identities.verifyEmailChange(token);
      res.redirect(302, this.changeEmailResultPath(changed ? 'changed' : 'invalid'));
    } catch (error) {
      // Same posture as the verification click: uniform redirect, diagnosable log.
      this.logger.error(
        `email change click failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.redirect(302, this.changeEmailResultPath('invalid'));
    }
  }

  /** Shape-checked outcome for the hosted email-change result page. */
  @Get('change-email/result')
  async changeEmailResultPageInfo(
    @Query('outcome') outcome: string | undefined,
  ): Promise<{ outcome: string; organizationName: string; branding: Branding }> {
    if (outcome === 'changed' || outcome === 'invalid') {
      return { outcome, ...(await this.pageInfo()) };
    }
    throw new BadRequestException('outcome must be "changed" or "invalid"');
  }

  @Get('forgot-password')
  forgotPasswordPageInfo(): Promise<{ organizationName: string; branding: Branding }> {
    return this.pageInfo();
  }

  /**
   * The "forgot password" form target. Uniform by design (ADR-0005/0020): the
   * same status and shape whether or not the email exists; the accepted/
   * refused distinction reaches the mailbox only.
   */
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @Req() req: Request,
    @Body() body: ForgotPasswordBody,
  ): Promise<{ status: 'check-your-mailbox' }> {
    await this.guardAttempt('forgot-password', req, body.email);
    await this.identities.requestPasswordReset(body);
    return { status: 'check-your-mailbox' };
  }

  /**
   * The reset page's data: is this link still live, and which Organization's
   * page is it? Never consumes the token — only completing the reset does.
   */
  @Get('reset-password')
  async resetPasswordPageInfo(@Query('token') token: string | undefined): Promise<{
    organizationName: string;
    valid: boolean;
    branding: Branding;
  }> {
    const valid =
      typeof token === 'string' &&
      token.length > 0 &&
      (await this.identities.validateResetToken(token));
    return { ...(await this.pageInfo()), valid };
  }

  /**
   * Completing a reset: sets the new password, proves mailbox control, and
   * revokes every Session. A dead token is the only failure — the page already
   * told the visitor the link was invalid, so there is nothing left to hide.
   */
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() body: ResetPasswordBody): Promise<{ status: 'password-reset' }> {
    const ok = await this.identities.resetPassword(body.token, body.password);
    if (!ok) throw new BadRequestException('this reset link is invalid or has expired');
    return { status: 'password-reset' };
  }

  /**
   * Rate-limit an unauthenticated request-initiating endpoint. Sign-up and
   * forgot-password answer uniformly by design (ADR-0005/0020), so there is no
   * success/failure signal to record: every request is one attempt, keyed by
   * the submitted email exactly as the Identity lookup normalizes it, so the
   * delay never distinguishes email-exists from email-not-exists.
   */
  private async guardAttempt(scope: ThrottleScope, req: Request, email: string): Promise<void> {
    const subject: ThrottleSubject = {
      source: req.ip ?? null,
      identity: normalizeEmail(email),
    };
    await this.throttle.wait(scope, subject);
    this.throttle.record(scope, subject);
  }

  private resultPath(outcome: 'verified' | 'invalid'): string {
    return `/end-users/verify-email/result?outcome=${outcome}`;
  }

  private changeEmailResultPath(outcome: 'changed' | 'invalid'): string {
    return `/end-users/change-email/result?outcome=${outcome}`;
  }

  /** The Organization's name and branding every hosted page renders. */
  private async pageInfo(): Promise<{ organizationName: string; branding: Branding }> {
    const organization = await this.identities.hostedOrganization();
    return {
      organizationName: organization.name,
      branding: await this.settings.branding(organization.id),
    };
  }
}
