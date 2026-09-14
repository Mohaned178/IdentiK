/**
 * Read an environment variable as optional trimmed text: absent, empty, and
 * whitespace-only values mean "not configured". Shared by every configuration
 * reader so the meaning of an unset variable is defined in exactly one place.
 */
export function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}
