/**
 * Whether an error is a SQLite uniqueness-constraint violation. The UNIQUE
 * constraint is the race-free arbiter for "this value is already taken", so
 * callers treat any such violation — including a lost race — as the same
 * refusal.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' &&
    error.message.includes('UNIQUE constraint failed')
  );
}
