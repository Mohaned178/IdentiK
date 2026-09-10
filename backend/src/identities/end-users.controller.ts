import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsEmail, IsString, MinLength } from 'class-validator';
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
@Controller('api/end-users')
export class EndUsersController {
  constructor(private readonly identities: IdentitiesService) {}

  @Get('sign-up')
  signUpPageInfo(): { organizationName: string } {
    return { organizationName: this.identities.hostedOrganization().name };
  }

  @Post('sign-up')
  @HttpCode(201)
  async signUp(@Body() body: SignUpBody): Promise<{ status: 'check-your-mailbox' }> {
    await this.identities.signUp(body);
    return { status: 'check-your-mailbox' };
  }

  /**
   * The verification click. This route exists to be opened from a mail
   * client, so it redirects (302) to the hosted result page; the outcome
   * lives in the redirect, and the SPA renders it.
   */
  @Get('verify-email')
  verifyEmail(
    @Query('token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): void {
    // Refuse without a token synchronously: redirect-with-empty-string below
    // would otherwise construct a URL ending in "token=".
    if (typeof token !== 'string' || token.length === 0) {
      res.redirect(302, this.resultPath('invalid'));
      return;
    }
    this.identities
      .verifyEmail(token)
      .then((verified) => res.redirect(302, this.resultPath(verified ? 'verified' : 'invalid')))
      .catch(() => res.redirect(302, this.resultPath('invalid')));
  }

  /** Shape-checked outcome for the hosted result page. */
  @Get('verify-email/result')
  resultPageInfo(@Query('outcome') outcome: string | undefined): { outcome: string } {
    if (outcome === 'verified' || outcome === 'invalid') return { outcome };
    throw new BadRequestException('outcome must be "verified" or "invalid"');
  }

  @Get('forgot-password')
  forgotPasswordPageInfo(): { organizationName: string } {
    return { organizationName: this.identities.hostedOrganization().name };
  }

  /**
   * The "forgot password" form target. Uniform by design (ADR-0005/0020): the
   * same status and shape whether or not the email exists; the accepted/
   * refused distinction reaches the mailbox only.
   */
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() body: ForgotPasswordBody): Promise<{ status: 'check-your-mailbox' }> {
    await this.identities.requestPasswordReset(body);
    return { status: 'check-your-mailbox' };
  }

  /**
   * The reset page's data: is this link still live, and which Organization's
   * page is it? Never consumes the token — only completing the reset does.
   */
  @Get('reset-password')
  resetPasswordPageInfo(@Query('token') token: string | undefined): {
    organizationName: string;
    valid: boolean;
  } {
    const organizationName = this.identities.hostedOrganization().name;
    const valid =
      typeof token === 'string' && token.length > 0 && this.identities.validateResetToken(token);
    return { organizationName, valid };
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

  private resultPath(outcome: 'verified' | 'invalid'): string {
    return `/end-users/verify-email/result?outcome=${outcome}`;
  }
}
