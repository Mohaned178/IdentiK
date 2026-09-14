import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import { IssuerService } from './issuer.service';
import { instanceConfig } from '../config/instance-config';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  client_id: string;
  scope: string;
  sid?: string;
  jti?: string;
}

interface LoadedKey {
  kid: string;
  privateKey?: KeyLike | Uint8Array;
  publicJwk: JWK;
}

/**
 * The platform's token signing and verification fabric (ADR-0015, ADR-0022).
 * Keys are deployment configuration, never a dashboard setting. The
 * `IDENTIK_SIGNING_JWKS` environment variable carries a JSON array of JWKs:
 * the first is the signing key (a rotation publishes the new key first, then
 * retires the old), and every key in the array is published at JWKS so tokens
 * signed by retired keys stay verifiable until they expire. When unset — dev
 * and test only — an ephemeral key is generated so the Instance is
 * self-contained; production operators configure stable keys, otherwise every
 * restart invalidates every outstanding token.
 */
@Injectable()
export class SigningKeysService implements OnModuleInit {
  private readonly logger = new Logger(SigningKeysService.name);
  private readonly keys: LoadedKey[] = [];
  private verifier!: ReturnType<typeof createLocalJWKSet>;

  constructor(private readonly issuer: IssuerService) {}

  async onModuleInit(): Promise<void> {
    const configured = instanceConfig().signingJwks;
    await this.load(configured ? this.parseConfigured(configured) : await this.ephemeral());
    this.verifier = createLocalJWKSet({ keys: this.keys.map((key) => key.publicJwk) });
  }

  /** The public verification keys, as OIDC expects to fetch them. */
  jwks(): { keys: JWK[] } {
    return { keys: this.keys.map((key) => key.publicJwk) };
  }

  async sign(claims: JWTPayload, type: 'JWT' | 'at+jwt'): Promise<string> {
    const key = this.keys[0];
    if (!key?.privateKey) throw new Error('no signing key is loaded');
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: type })
      .sign(key.privateKey);
  }

  /**
   * Verify an access token against the platform's own keys, issuer, audience,
   * and `at+jwt` type. An ID token presented here fails: the type separates
   * assertions about the person from credentials for the platform's endpoints.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.verifier, {
        issuer: this.issuer.issuer(),
        audience: this.issuer.audience(),
        typ: 'at+jwt',
      });
      if (typeof payload.sub !== 'string' || typeof payload.client_id !== 'string') {
        return null;
      }
      return payload as AccessTokenClaims;
    } catch {
      return null;
    }
  }

  private parseConfigured(raw: string): JWK[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('IDENTIK_SIGNING_JWKS is not valid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('IDENTIK_SIGNING_JWKS must be a non-empty JSON array of JWKs');
    }
    return parsed as JWK[];
  }

  private async ephemeral(): Promise<JWK[]> {
    this.logger.warn(
      'IDENTIK_SIGNING_JWKS is not set — generating an ephemeral signing key. ' +
        'Configure stable keys in deployment configuration for production.',
    );
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    return [await exportJWK(privateKey)];
  }

  private async load(jwks: JWK[]): Promise<void> {
    for (const [index, jwk] of jwks.entries()) {
      if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
        throw new Error('IDENTIK_SIGNING_JWKS entries must be RSA public keys (RS256)');
      }
      const kid = jwk.kid ?? (await calculateJwkThumbprint(jwk));
      const key: LoadedKey = {
        kid,
        publicJwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid, use: 'sig', alg: 'RS256' },
      };
      if (index === 0) {
        if (!jwk.d) {
          throw new Error('the first IDENTIK_SIGNING_JWKS entry must be a private JWK (it signs)');
        }
        key.privateKey = await importJWK(jwk, 'RS256');
      }
      this.keys.push(key);
    }
  }
}
