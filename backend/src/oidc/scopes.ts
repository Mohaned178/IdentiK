export const SUPPORTED_SCOPES = new Set(['openid', 'email', 'profile']);

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
