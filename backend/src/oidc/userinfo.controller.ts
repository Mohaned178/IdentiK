import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { optionalText } from '../common/text';
import { TokenService } from './token.service';

/**
 * Userinfo (OIDC Core §5.3) — the platform endpoint access tokens are
 * actually for (ADR-0015). Both GET and POST are served, as the spec requires:
 * the token arrives as a Bearer credential or, on POST, as the `access_token`
 * form parameter. Claims are scoped by the integration scopes recorded in the
 * token: `openid` always yields the subject, `email` adds the address and its
 * verification state, `profile` adds the handle. A token for a suspended or
 * anonymized Identity is refused at ask-time.
 */
@Controller('api/oidc')
export class UserInfoController {
  constructor(private readonly tokens: TokenService) {}

  @Get('userinfo')
  async userinfoGet(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.respond(bearerToken(req.headers.authorization), res);
  }

  @Post('userinfo')
  @HttpCode(200)
  async userinfoPost(
    @Req() req: Request,
    @Body() body: { access_token?: unknown } | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.respond(
      optionalText(body?.access_token) ?? bearerToken(req.headers.authorization),
      res,
    );
  }

  private async respond(accessToken: string | undefined, res: Response): Promise<void> {
    const result = await this.tokens.userInfo(accessToken);
    // Claims travel in this response and must not be stored (OIDC Core §5.3.3).
    res.setHeader('Cache-Control', 'no-store');
    if (result.status === 401) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      res.status(401).json({ error: 'invalid_token', error_description: result.description });
      return;
    }
    res.json(result.body);
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : undefined;
}
