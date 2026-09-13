import { Injectable } from '@nestjs/common';
import {
  ApplicationsService,
  type ApplicationType,
} from '../applications/applications.service';

export interface PresentedCredentials {
  /** The raw `Authorization` header, when one was sent. */
  authorization?: string;
  clientId?: string;
  clientSecret?: string;
}

export type ClientAuthenticationMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface AuthenticatedClient {
  id: string;
  clientId: string;
  organizationId: string;
  type: ApplicationType;
  /** False while the Application is Disabled, or once it is Deleted. */
  enabled: boolean;
  /** The scopes the Application is configured for, current as of this request. */
  allowedScopes: string[];
  method: ClientAuthenticationMethod;
}

export type ClientAuthentication =
  | { ok: true; client: AuthenticatedClient }
  | { ok: false; description: string };

/**
 * Client authentication at the token, revocation, and introspection
 * endpoints (RFC 6749 §2.3, OIDC Core §9). A confidential client must prove
 * possession of a currently-valid Client Secret, by `client_secret_basic` or
 * `client_secret_post`. A public client has no secret to prove: its Client ID
 * alone identifies it and PKCE is the proof of possession — presenting a
 * secret on a public client is refused, so a leakable secret structurally
 * cannot come into use (ADR-0009).
 */
@Injectable()
export class ClientAuthenticationService {
  constructor(private readonly applications: ApplicationsService) {}

  async authenticate(credentials: PresentedCredentials): Promise<ClientAuthentication> {
    const header = credentials.authorization?.trim();
    const basicHeader = header !== undefined && /^Basic /i.test(header);
    if (header !== undefined && header.length > 0 && !basicHeader) {
      return { ok: false, description: 'unsupported client authentication method' };
    }
    if (header && credentials.clientSecret !== undefined) {
      return { ok: false, description: 'multiple client authentication methods were used' };
    }

    const basic = basicHeader ? parseBasic(header!) : null;
    if (header && !basic) {
      return { ok: false, description: 'malformed Basic client authentication' };
    }
    if (basic && credentials.clientId !== undefined && credentials.clientId !== basic.clientId) {
      return { ok: false, description: 'client_id does not match the authenticated client' };
    }

    const clientId = basic?.clientId ?? credentials.clientId;
    if (!clientId) return { ok: false, description: 'client_id is required' };
    const application = await this.applications.findClient(clientId);
    if (!application) return { ok: false, description: 'unknown client' };

    const secret = basic ? basic.secret : (credentials.clientSecret ?? undefined);
    if (application.type === 'spa') {
      if (secret !== undefined && secret.length > 0) {
        return { ok: false, description: 'a public client must not present a Client Secret' };
      }
      return { ok: true, client: { ...application, method: 'none' } };
    }

    if (!secret) return { ok: false, description: 'client authentication is required' };
    if (!(await this.applications.verifyClientSecret(application.id, secret))) {
      return { ok: false, description: 'invalid Client Secret' };
    }
    return {
      ok: true,
      client: { ...application, method: basic ? 'client_secret_basic' : 'client_secret_post' },
    };
  }
}

/**
 * RFC 6749 §2.3.1: the Client ID and Secret travel form-urlencoded inside the
 * Basic credentials. Tolerate values that were not encoded when decoding.
 */
function parseBasic(header: string): { clientId: string; secret: string } | null {
  const encoded = header.slice('Basic '.length).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    clientId: decodeComponent(decoded.slice(0, separator)),
    secret: decodeComponent(decoded.slice(separator + 1)),
  };
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
