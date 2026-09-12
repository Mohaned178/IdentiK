export const SUPPORTED_SCOPES = new Set(['openid', 'email', 'profile']);

/** The canonical order configured scope sets are stored and displayed in. */
export const CANONICAL_SCOPES = ['openid', 'email', 'profile'];

/** The scope set a newly registered Application starts with. */
export const DEFAULT_APPLICATION_SCOPES = [...CANONICAL_SCOPES];

/** The scope tokens in a space-delimited scope string. */
export function splitScope(value: string): string[] {
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}

/**
 * The validated scope set of an authorization request: `openid` is required
 * and only the supported scopes are served. Returns null for anything else.
 * Scopes are integration configuration governing token contents, not
 * user-granted permissions (ADR-0016).
 */
export function parseSupportedScope(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  const scopes = [...new Set(splitScope(value.trim()))];
  if (!scopes.includes('openid')) return null;
  if (scopes.some((scope) => !SUPPORTED_SCOPES.has(scope))) return null;
  return scopes;
}

/**
 * The validated scope set an Administrator configures for one Application:
 * non-empty, only supported scopes, `openid` included (every flow here is
 * OIDC), deduplicated into canonical order. Returns null for anything else.
 */
export function parseConfiguredScope(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((entry) => typeof entry !== 'string')) return null;
  const unique = [...new Set(value as string[])];
  if (unique.some((scope) => !SUPPORTED_SCOPES.has(scope))) return null;
  if (!unique.includes('openid')) return null;
  return CANONICAL_SCOPES.filter((scope) => unique.includes(scope));
}

/** Whether every requested scope is in the Application's configured set. */
export function scopeWithin(allowed: string[], requested: string[]): boolean {
  return requested.every((scope) => allowed.includes(scope));
}
