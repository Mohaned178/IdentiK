import { Controller, Get } from '@nestjs/common';
import type { JWK } from 'jose';
import { IssuerService } from './issuer.service';
import { SigningKeysService } from './signing-keys.service';

/**
 * Discovery (OIDC Discovery 1.0) and JWKS. Together these make the Instance
 * self-describing to any stock OIDC client and keep token verification offline:
 * an Application fetches the public keys once and verifies assertions without
 * asking the platform on every request (ADR-0015).
 */
@Controller()
export class DiscoveryController {
  constructor(
    private readonly issuer: IssuerService,
    private readonly signing: SigningKeysService,
  ) {}

  @Get('.well-known/openid-configuration')
  discovery(): Record<string, unknown> {
    return this.issuer.discovery();
  }

  @Get('api/oidc/jwks')
  jwks(): { keys: JWK[] } {
    return this.signing.jwks();
  }
}
