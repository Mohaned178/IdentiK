import { Injectable } from '@nestjs/common';

/**
 * Link base for outbound email. Derived from the Instance's own deployed URL,
 * held in deployment configuration (the Instance Operator's trust fabric per
 * ADR-0022) — never the Host header of an incoming request, which an attacker
 * controls and would use to smuggle verification links to their own server.
 * Validated at boot so a misconfigured Instance fails closed, loudly.
 */
@Injectable()
export class LinkBaseService {
  private readonly base: string;

  constructor() {
    const raw = process.env.IDENTIK_BASE_URL;
    if (!raw) {
      throw new Error(
        'IDENTIK_BASE_URL must be set to the externally reachable URL of this Instance ' +
          '(e.g. https://id.example.com) — it is the base for verification and reset links.',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`IDENTIK_BASE_URL "${raw}" is not a valid absolute URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`IDENTIK_BASE_URL "${raw}" must be an http(s) URL.`);
    }
    this.base = raw.replace(/\/+$/, '');
  }

  resolve(): string {
    return this.base;
  }
}
