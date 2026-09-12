/**
 * Parse a positive-millisecond duration from the Instance Operator's
 * deployment configuration, falling back to the feature's default when unset
 * or nonsensical. The exact windows are deliberately left open by the spec.
 */
export function parseTtlMs(name: string, fallbackMs: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

/**
 * Parse a non-negative whole-number count (e.g. the number of attempts
 * allowed before throttling escalates) from deployment configuration,
 * falling back when unset or nonsensical.
 */
export function parseCount(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}
