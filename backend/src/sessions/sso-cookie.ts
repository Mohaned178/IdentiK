import type { Request } from 'express';
import { cookieToken } from '../config/cookies';

/** The platform SSO cookie: one Session, one signed-in device (ADR-0013). */
export const SSO_COOKIE = 'identik_sso_session';

export function ssoTokenFrom(req: Request): string | null {
  return cookieToken(req, SSO_COOKIE);
}
