import type { OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import type { DataAccess, RunResult } from './data-access';

/**
 * The raw query surface shared by the root ORM client and an interactive
 * transaction client. Keeping it structural avoids leaking generated-model
 * types into the temporary facade; Stage 2 replaces both.
 */
interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Whether a write failed on a unique constraint. PostgreSQL reports SQLSTATE
 * 23505; Prisma wraps raw driver failures in a raw-query error whose metadata
 * still carries the original code. The unique constraint is the race-free
 * arbiter for "this value is already taken", so callers treat any such
 * violation — including a lost race — as the same refusal. Stage 2's typed
 * queries surface the same races as `P2002`.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const shape = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    shape.code === '23505' || shape.meta?.driverAdapterError?.cause?.originalCode === '23505'
  );
}

/**
 * Map the facade's `?` placeholders to PostgreSQL's `$n`, skipping
 * single-quoted literals so a question mark inside SQL text is never touched.
 * Doubled quotes (the SQL escape) toggle twice and leave the state unchanged.
 */
function toPositionalPlaceholders(sql: string): string {
  let index = 0;
  let inLiteral = false;
  let mapped = '';
  for (const character of sql) {
    if (character === "'") inLiteral = !inLiteral;
    mapped += character === '?' && !inLiteral ? `$${++index}` : character;
  }
  return mapped;
}

/**
 * Temporary Stage 1 implementation of the data-access contract (ADR-0026,
 * ADR-0027): the prepared-statement shape the services already use, backed by
 * the ORM client's parameterized raw statements over PostgreSQL. Statements
 * keep their `?` placeholders; writes report affected rows; reads return the
 * first row or every row; `transaction(fn)` binds one connection for the whole
 * unit of work. Deleted in Finalize.
 */
class PrismaRawAccess implements DataAccess {
  constructor(private readonly client: RawClient) {}

  async run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    const rowCount = await this.client.$executeRawUnsafe(toPositionalPlaceholders(sql), ...params);
    return { rowCount };
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | undefined> {
    const rows = await this.client.$queryRawUnsafe<T[]>(toPositionalPlaceholders(sql), ...params);
    return rows[0];
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    return this.client.$queryRawUnsafe<T[]>(toPositionalPlaceholders(sql), ...params);
  }

  exec(sql: string): Promise<void> {
    return this.client.$executeRawUnsafe(toPositionalPlaceholders(sql)).then(() => undefined);
  }

  transaction<T>(_fn: (tx: DataAccess) => Promise<T>): Promise<T> {
    return Promise.reject(new Error('nested transactions are not supported'));
  }
}

/**
 * The Instance's data handle on PostgreSQL: the Stage 1 facade plus the
 * lifecycle of the ORM client and its connection pool. One client is injected
 * everywhere through the `DATABASE` token; no repository layer sits above it.
 */
export class PrismaDatabase extends PrismaRawAccess implements OnModuleDestroy {
  constructor(private readonly prisma: PrismaClient) {
    super(prisma);
  }

  override transaction<T>(fn: (tx: DataAccess) => Promise<T>): Promise<T> {
    // SQLite let a unit of work run as long as it needed on the one
    // connection; the interactive transaction's defaults (5s timeout, 2s wait
    // for a connection) would be a new failure mode for large cascades. Keep
    // both generous until Stage 2 revisits transaction policy.
    return this.prisma.$transaction((tx) => fn(new PrismaRawAccess(tx)), {
      maxWait: 10_000,
      timeout: 30_000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
