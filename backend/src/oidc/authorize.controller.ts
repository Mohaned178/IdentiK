import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { LinkBaseService } from '../config/link-base.service';
import { sessionCookieOptions } from '../config/cookies';
import { SSO_COOKIE, ssoTokenFrom } from '../sessions/sso-cookie';
import { SessionsService } from '../sessions/sessions.service';
import { normalizeEmail } from '../identities/email';
import { ThrottleService, type ThrottleSubject } from '../throttle/throttle.service';
import {
  AuthorizationRequest,
  AuthorizeOutcome,
  AuthorizeService,
} from './authorize.service';

class SignInBody {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/**
 * The authorization endpoint (ADR-0015, ADR-0018) and the hosted sign-in
 * page's data. GET validates the request and either redirects a live Session
 * straight back with a code or serves the page's data; POST is the page's form
 * target. This controller owns the response deliberately: an authorization
 * endpoint's status and Location are protocol, not decoration.
 */
@Controller('api/oidc')
export class AuthorizeController {
  constructor(
    private readonly authorize: AuthorizeService,
    private readonly sessions: SessionsService,
    private readonly links: LinkBaseService,
    private readonly throttle: ThrottleService,
  ) {}

  @Get('authorize')
  begin(@Req() req: Request, @Res() res: Response): void {
    this.render(this.authorize.begin(readAuthorizationRequest(req), ssoTokenFrom(req)), res);
  }

  @Post('authorize')
  @HttpCode(200)
  async signIn(
    @Req() req: Request,
    @Body() body: SignInBody,
    @Res() res: Response,
  ): Promise<void> {
    // Escalating delay for the credential attempt (ADR-0020). The key uses the
    // submitted email whether or not an Identity owns it, so the delay never
    // distinguishes email-exists from email-not-exists.
    const subject: ThrottleSubject = {
      source: req.ip ?? null,
      identity: normalizeEmail(body.email),
    };
    await this.throttle.wait('sign-in', subject);

    const outcome = await this.authorize.signIn(
      readAuthorizationRequest(req),
      body,
      ssoTokenFrom(req),
      {
        source: req.ip ?? null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      },
    );

    if (outcome.kind === 'invalid-credentials') {
      // A refusal is the credential campaign signal: it feeds the next
      // attempt's delay and is already audited by the authorization service.
      this.throttle.record('sign-in', subject);
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    if (outcome.kind === 'redirect-with-session') {
      // The credential was proven: forget this Identity's failures so an
      // Identity is never punished for having mistyped. The source history
      // stays, so scanning remains slow.
      this.throttle.recordSuccess('sign-in', subject);
      res.cookie(SSO_COOKIE, outcome.sessionToken, {
        ...sessionCookieOptions(this.links.resolve()),
        maxAge: this.sessions.ttlMs(),
      });
      res.redirect(302, outcome.location);
      return;
    }
    this.render(outcome, res);
  }

  private render(outcome: AuthorizeOutcome, res: Response): void {
    if (outcome.kind === 'page') {
      res.json(outcome.page);
      return;
    }
    if (outcome.kind === 'redirect') {
      res.redirect(302, outcome.location);
      return;
    }
    res.status(outcome.status).json({
      error: outcome.error,
      error_description: outcome.errorDescription,
    });
  }
}

/** The authorization request travels in the query, exactly like OIDC expects. */
function readAuthorizationRequest(req: Request): AuthorizationRequest {
  const query = req.query as Record<string, unknown>;
  const queryText = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  return {
    clientId: queryText(query.client_id),
    redirectUri: queryText(query.redirect_uri),
    responseType: queryText(query.response_type),
    scope: queryText(query.scope),
    state: queryText(query.state),
    nonce: queryText(query.nonce),
    codeChallenge: queryText(query.code_challenge),
    codeChallengeMethod: queryText(query.code_challenge_method),
  };
}
