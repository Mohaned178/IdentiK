import type { Request, Response } from 'express';
import type { PresentedCredentials } from './client-authentication.service';
import { optionalText } from '../common/text';

export interface ClientCredentialsBody {
  client_id?: unknown;
  client_secret?: unknown;
}

/** The client credentials a token-surface request presents, from header or body. */
export function presentedCredentials(
  req: Request,
  body: ClientCredentialsBody | undefined,
): PresentedCredentials {
  return {
    authorization: req.headers.authorization,
    clientId: optionalText(body?.client_id),
    clientSecret: optionalText(body?.client_secret),
  };
}

/**
 * An `invalid_client` refusal (RFC 6749 §5.2). When the client authenticated
 * with the Authorization header, the response MUST carry the matching
 * `WWW-Authenticate` challenge.
 */
export function sendInvalidClient(
  res: Response,
  credentials: PresentedCredentials,
  description: string,
): void {
  // Scheme names are case-insensitive (RFC 7235 §2.1).
  if (/^Basic /i.test(credentials.authorization ?? '')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="identik", charset="UTF-8"');
  }
  res.status(401).json({ error: 'invalid_client', error_description: description });
}
