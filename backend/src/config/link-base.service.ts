import { Injectable } from '@nestjs/common';
import { instanceConfig } from './instance-config';

/**
 * Link base for outbound email. Derived from the Instance's own deployed URL,
 * held in deployment configuration (the Instance Operator's trust fabric per
 * ADR-0022) — never the Host header of an incoming request, which an attacker
 * controls and would use to smuggle verification links to their own server.
 * Validated at boot by the instance configuration schema, so a misconfigured
 * Instance fails closed, loudly.
 */
@Injectable()
export class LinkBaseService {
  private readonly base = instanceConfig().baseUrl;

  resolve(): string {
    return this.base;
  }
}
