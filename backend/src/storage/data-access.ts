import type { Prisma } from '../generated/prisma/client';

/**
 * The temporary Stage 1 data-access contract (ADR-0026, ADR-0027): the shape
 * the PostgreSQL compatibility surface provides while services convert to
 * typed access. Statements use `?` placeholders; writes report affected rows;
 * reads return the first row or every row; `transaction(fn)` binds one
 * connection for the whole unit of work and hands the callback the data
 * handle bound to it, so a converted caller can use typed models inside the
 * same transaction.
 *
 * It is provided by `PrismaService` through the `DATABASE` token. The layer is
 * deliberately temporary: it is deleted in Finalize, and services reach it
 * only through the transaction handle or the `Database` alias.
 */
export interface RunResult {
  rowCount: number;
}

/**
 * A data handle bound to one connection: what an interactive transaction
 * callback receives, and what any unit of work accepts. It carries the typed
 * client surface the transaction provides — never the pool lifecycle methods
 * — plus the temporary facade, so converted and unconverted callers can share
 * the same unit of work until Finalize.
 */
export type DataHandle = Prisma.TransactionClient & DataAccess;

export interface DataAccess {
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  get<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DataHandle) => Promise<T>): Promise<T>;
}
