import type { CookieOptions, Request } from 'express';

/**
 * Read one cookie's raw value. Values are opaque tokens, so no decoding is
 * attempted beyond trimming the surrounding syntax.
 */
export function cookieToken(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Whether the configured public origin is https. Read from the parsed URL, not
 * a prefix match, so scheme casing never decides whether cookies are Secure or
 * HSTS is sent.
 */
export function isHttpsOrigin(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Cookie attributes shared by platform session cookies. Secure follows the
 * deployment's configured base URL, never the request, so the flag matches
 * the scheme the Instance is actually served under.
 */
export function sessionCookieOptions(baseUrl: string): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsOrigin(baseUrl),
    path: '/',
  };
}
