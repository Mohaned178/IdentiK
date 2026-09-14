import { type CountName, type DurationName, instanceConfig } from './instance-config';

/**
 * Read a deployment duration from the validated configuration. Values were
 * validated once at startup (see instance-config); a variable that is absent
 * keeps the caller's documented default. Present-but-invalid values never
 * reach here — they fail startup with the variable named.
 */
export function parseTtlMs(name: DurationName, fallbackMs: number): number {
  return instanceConfig().durations.get(name) ?? fallbackMs;
}

/**
 * Read a non-negative whole-number count from the validated configuration
 * (e.g. the number of attempts allowed before throttling escalates). Absent
 * names keep the caller's documented default.
 */
export function parseCount(name: CountName, fallback: number): number {
  return instanceConfig().counts.get(name) ?? fallback;
}
