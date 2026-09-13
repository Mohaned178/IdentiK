import { Injectable } from '@nestjs/common';
import { LinkBaseService } from '../config/link-base.service';
import { SUPPORTED_SCOPES } from './scopes';

/**
 * The OIDC issuer identity: the Instance's own externally reachable URL, which
 * every token's `iss` claim and every discovery URL derive from. Held in
 * deployment configuration (ADR-0022), never derived from an incoming request.
 */
@Injectable()
export class IssuerService {
  constructor(private readonly links: LinkBaseService) {}

  issuer(): string {
    return this.links.resolve();
  }

  /**
   * Access tokens are for the platform's own endpoints (ADR-0015) — userinfo
   * and the introspection surface — never for a client Application's
   * resources. The audience is therefore the Instance itself.
   */
  audience(): string {
    return this.issuer();
  }

  authorizationEndpoint(): string {
    return `${this.issuer()}/api/oidc/authorize`;
  }

  tokenEndpoint(): string {
    return `${this.issuer()}/api/oidc/token`;
  }

  userinfoEndpoint(): string {
    return `${this.issuer()}/api/oidc/userinfo`;
  }

  jwksUri(): string {
    return `${this.issuer()}/api/oidc/jwks`;
  }

  revocationEndpoint(): string {
    return `${this.issuer()}/api/oidc/revoke`;
  }

  introspectionEndpoint(): string {
    return `${this.issuer()}/api/oidc/introspect`;
  }

  /**
   * The discovery document (OIDC Discovery 1.0): everything a stock client
   * library needs to work without proprietary knowledge. The declared
   * capabilities are exactly what this release serves — code + PKCE,
   * rotating refresh tokens, RS256 JWTs.
   */
  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer(),
      authorization_endpoint: this.authorizationEndpoint(),
      token_endpoint: this.tokenEndpoint(),
      userinfo_endpoint: this.userinfoEndpoint(),
      jwks_uri: this.jwksUri(),
      revocation_endpoint: this.revocationEndpoint(),
      introspection_endpoint: this.introspectionEndpoint(),
      scopes_supported: [...SUPPORTED_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none',
      ],
      revocation_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none',
      ],
      introspection_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none',
      ],
      code_challenge_methods_supported: ['S256'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'sid',
        'email',
        'email_verified',
        'preferred_username',
      ],
    };
  }
}
