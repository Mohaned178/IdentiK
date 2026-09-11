import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ClientAuthenticationService,
  type AuthenticatedClient,
} from './client-authentication.service';
import { presentedCredentials, sendInvalidClient } from './client-request';
import { TokenService } from './token.service';
import { optionalText } from './text';

interface TokenManagementRequest {
  token?: unknown;
  token_type_hint?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
}

/**
 * Revocation (RFC 7009) and introspection (RFC 7662). Both require client
 * authentication (a public client identifies itself by Client ID alone, as it
 * does at the token endpoint) and the token to inspect. Revocation answers
 * uniformly whatever it was handed — an unknown token is not an error and
 * reveals nothing.
 */
@Controller('api/oidc')
export class TokenManagementController {
  constructor(
    private readonly clients: ClientAuthenticationService,
    private readonly tokens: TokenService,
  ) {}

  @Post('revoke')
  @HttpCode(200)
  async revoke(
    @Req() req: Request,
    @Body() body: TokenManagementRequest,
    @Res() res: Response,
  ): Promise<void> {
    const result = this.authenticate(req, body, res);
    if (!result) return;
    this.tokens.revoke(result.client, result.token);
    res.status(200).send();
  }

  @Post('introspect')
  @HttpCode(200)
  async introspect(
    @Req() req: Request,
    @Body() body: TokenManagementRequest,
    @Res() res: Response,
  ): Promise<void> {
    const result = this.authenticate(req, body, res);
    if (!result) return;
    // RFC 7662 §4: introspection verdicts must not be stored.
    res.setHeader('Cache-Control', 'no-store');
    res.json(await this.tokens.introspect(result.client, result.token));
  }

  /**
   * Client authentication first, then the required `token` parameter
   * (RFC 7009 §2.1, RFC 7662 §2.1). Failures are written here because OAuth
   * errors are protocol-shaped JSON.
   */
  private authenticate(
    req: Request,
    body: TokenManagementRequest,
    res: Response,
  ): { client: AuthenticatedClient; token: string } | null {
    const credentials = presentedCredentials(req, body);
    const authentication = this.clients.authenticate(credentials);
    if (!authentication.ok) {
      sendInvalidClient(res, credentials, authentication.description);
      return null;
    }
    const token = optionalText(body.token);
    if (!token) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'token is required',
      });
      return null;
    }
    return { client: authentication.client, token };
  }
}
