import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { isHttpsOrigin } from '../config/cookies';
import type { InstanceConfiguration } from '../config/instance-config';

/** One year, the conventional HSTS floor. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * The network-edge posture: the operator states which proxies may assert a
 * client's address; HSTS follows the configured public origin, never a
 * forwarded header; every response carries the baseline browser headers; and
 * TLS termination — including the HTTP-to-HTTPS redirect — belongs to the
 * operator's proxy, so the Instance itself never redirects.
 */
export function installEdgePosture(
  app: NestExpressApplication,
  config: InstanceConfiguration,
): void {
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  const hsts = isHttpsOrigin(config.baseUrl)
    ? `max-age=${HSTS_MAX_AGE_SECONDS}`
    : null;

  app.use((_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    if (hsts !== null) res.setHeader('Strict-Transport-Security', hsts);
    next();
  });
}
