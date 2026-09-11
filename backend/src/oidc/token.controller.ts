import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClientAuthenticationService } from './client-authentication.service';
import { presentedCredentials, sendInvalidClient } from './client-request';
import { TokenRequest, TokenService } from './token.service';

/**
 * The token endpoint (RFC 6749 §3.2). Client authentication happens here,
 * once, before any grant is considered — an unauthenticated or
 * secret-misusing client never reaches the code or refresh logic. Errors are
 * OAuth-shaped JSON, not the platform's exception envelope, because this is
 * protocol.
 */
@Controller('api/oidc')
export class TokenController {
  constructor(
    private readonly clients: ClientAuthenticationService,
    private readonly tokens: TokenService,
  ) {}

  @Post('token')
  @HttpCode(200)
  async token(
    @Req() req: Request,
    @Body() body: TokenRequest,
    @Res() res: Response,
  ): Promise<void> {
    const credentials = presentedCredentials(req, body);
    const authentication = this.clients.authenticate(credentials);
    if (!authentication.ok) {
      sendInvalidClient(res, credentials, authentication.description);
      return;
    }

    const result = await this.tokens.handleGrant(authentication.client, body);
    if (result.status !== 200) {
      res.status(result.status).json({
        error: result.error,
        error_description: result.error_description,
      });
      return;
    }
    // RFC 6749 §5.1: a response containing tokens must not be stored.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json(result.body);
  }
}
