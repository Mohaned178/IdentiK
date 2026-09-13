/**
 * The temporary Stage 1 data-access contract (ADR-0026, ADR-0027): the shape
 * the final PostgreSQL compatibility layer provides while services convert to
 * async access. Statements use `?` placeholders; writes report affected rows;
 * reads return the first row or every row; `transaction(fn)` binds one
 * connection for the whole unit of work.
 *
 * It is implemented over SQLite during the engine swap and over Prisma's
 * parameterized raw queries once the Instance runs on PostgreSQL. The layer
 * is deliberately temporary: it is deleted in Finalize, and services reach it
 * only through the `Database` alias or the transaction client a unit of work
 * receives.
 */
export interface RunResult {
  rowCount: number;
}

export interface DataAccess {
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  get<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DataAccess) => Promise<T>): Promise<T>;
}
