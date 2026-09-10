import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Res,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { DATABASE, Database } from '../storage/token';
import { IdentitiesService } from './identities.service';

class SignUpBody {
  @IsEmail()
  email!: string;

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
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly identities: IdentitiesService,
  ) {}

  @Get('sign-up')
  signUpPageInfo(): { organizationName: string } {
    return { organizationName: this.organizationName() };
  }

  @Post('sign-up')
  @HttpCode(201)
  async signUp(@Body() body: SignUpBody): Promise<{ status: 'check-your-mailbox' }> {
    // Uniform work: every path hashes a password and sends exactly one email
    // before this returns, whatever the outcome.
    await this.identities.signUp(this.organizationId(), this.organizationName(), body);
    return { status: 'check-your-mailbox' };
  }

  /**
   * The verification click. This route exists to be opened from a mail
   * client, so it redirects (302) to the hosted result page; the outcome
   * lives in the query string, never the body, so the redirect target is
   * shareable/bookmarkable and the SPA renders it.
   */
  @Get('verify-email')
  async verifyEmail(
    @Query('token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (typeof token !== 'string' || token.length === 0) {
      this.redirect(res, 'invalid');
      return;
    }
    const identity = await this.identities.verifyEmail(token);
    this.redirect(res, identity ? 'verified' : 'invalid');
  }

  @Get('verify-email/result')
  resultPageInfo(@Query('outcome') outcome: string | undefined): { outcome: string } {
    if (outcome === 'verified' || outcome === 'invalid') return { outcome };
    throw new BadRequestException('outcome must be "verified" or "invalid"');
  }

  private redirect(res: Response, outcome: string): void {
    res.redirect(302, `/end-users/verify-email/result?outcome=${outcome}`);
  }

  private organization(): { id: string; name: string } {
    const row = this.db
      .prepare('SELECT id, name FROM organizations ORDER BY created_at LIMIT 1')
      .get() as { id: string; name: string } | undefined;
    if (!row) throw new NotFoundException('no organization exists on this Instance');
    return row;
  }

  private organizationId(): string {
    return this.organization().id;
  }

  private organizationName(): string {
    return this.organization().name;
  }
}
