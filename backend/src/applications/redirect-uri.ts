import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';

/**
 * The redirect-URI security rule (ADR-0010): a stored URI is one concrete
 * absolute URL, HTTPS anywhere with a plain-HTTP carve-out for loopback
 * development only. Wildcards and prefix patterns have no representation
 * here and are refused at the door. The returned string is the canonical
 * form exact matching compares against, so equivalent spellings cannot
 * enter the store twice.
 */
export function validateRedirectUri(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0) {
    throw new BadRequestException('a redirect URI is required');
  }
  if (candidate.includes('*')) {
    throw new BadRequestException(
      'redirect URIs are matched exactly: wildcards and patterns are not permitted',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BadRequestException('a redirect URI must be a valid absolute URL');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new BadRequestException('a redirect URI must not embed credentials');
  }
  if (parsed.hash !== '') {
    throw new BadRequestException('a redirect URI must not contain a fragment');
  }
  if (parsed.protocol === 'http:') {
    if (!isLoopbackHost(parsed.hostname)) {
      throw new BadRequestException(
        'plain HTTP redirect URIs are permitted only for loopback hosts',
      );
    }
  } else if (parsed.protocol !== 'https:') {
    throw new BadRequestException('a redirect URI must use HTTPS');
  }

  return parsed.href;
}

/** localhost, the whole 127.0.0.0/8 loopback block, and IPv6 ::1. */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIP(hostname) === 4 && hostname.startsWith('127.');
}
