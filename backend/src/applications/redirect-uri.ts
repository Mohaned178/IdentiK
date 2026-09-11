import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';

/**
 * The redirect-URI security rule (ADR-0010): a stored URI is one concrete
 * absolute URL, HTTPS anywhere with a plain-HTTP carve-out for loopback
 * development only. Wildcards and prefix patterns have no representation
 * here and are refused at the door. The returned string is the canonical
 * form exact matching compares against, so equivalent spellings cannot
 * enter the store twice.
 *
 * The match target is the whole canonical URI — scheme, host, port, path,
 * and any query string. Equality on more components than the rule names is
 * strictly safe: it can never let a URI through that the four-component
 * comparison would refuse.
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

  const parsed = parseAbsoluteUrl(candidate);
  if (!parsed) {
    throw new BadRequestException('a redirect URI must be a valid absolute URL');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new BadRequestException('a redirect URI must not embed credentials');
  }
  // Check the raw text, not `parsed.hash`: an empty fragment (`...#`) is
  // still a fragment, and OAuth forbids fragments on redirect URIs outright.
  if (candidate.includes('#')) {
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

  return canonicalHref(parsed);
}

/**
 * The canonical form of a submitted redirect URI, or null when it is not an
 * absolute URL. Exact matching compares these canonical forms, so the
 * authorization endpoint (ticket 09) shares this one definition of what a
 * stored URI is.
 */
export function canonicalRedirectUri(value: string): string | null {
  const parsed = parseAbsoluteUrl(value);
  return parsed ? canonicalHref(parsed) : null;
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * The one canonical form configuration stores and matching compares. An empty
 * query delimiter (`...?`) is not a component with content, so it is dropped
 * rather than becoming a distinct match target.
 */
function canonicalHref(parsed: URL): string {
  return parsed.search === '' && parsed.href.endsWith('?') ? parsed.href.slice(0, -1) : parsed.href;
}

/** localhost, the whole 127.0.0.0/8 loopback block, and IPv6 ::1. */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIP(hostname) === 4 && hostname.startsWith('127.');
}
