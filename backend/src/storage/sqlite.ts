import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { DataAccess, RunResult } from './data-access';

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

/**
 * Temporary SQLite-backed implementation of the Stage 1 data-access contract.
 * The async methods are the shape the PostgreSQL compatibility layer will
 * provide; `prepare` keeps the legacy synchronous surface alive for modules
 * that have not converted yet. Both halves share the one SQLite connection, so
 * a contract transaction and a legacy `BEGIN` see the same database.
 *
 * Each statement method executes synchronously under the hood and returns an
 * already-resolved promise, and a failure throws synchronously (an `await`
 * caller sees that as a rejection). That keeps unconverted synchronous call
 * sites — including their `try`/`catch` rollbacks — behaviorally identical
 * while the conversion is staged; the PostgreSQL implementation is genuinely
 * async. Deleted with the engine swap.
 */
export class SqliteDatabase implements DataAccess {
  constructor(private readonly db: DatabaseSync) {}

  run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...(params as readonly SQLInputValue[]));
    return Promise.resolve({ rowCount: Number(result.changes) });
  }

  get<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | undefined> {
    const row = this.db.prepare(sql).get(...(params as readonly SQLInputValue[]));
    return Promise.resolve(row as T | undefined);
  }

  all<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...(params as readonly SQLInputValue[]));
    return Promise.resolve(rows as T[]);
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  async transaction<T>(fn: (tx: DataAccess) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Legacy escape hatch for modules not yet converted; removed with them. */
  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }
}
