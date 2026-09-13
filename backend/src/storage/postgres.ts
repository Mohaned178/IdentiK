import type { Prisma } from '../generated/prisma/client';
import type { DataAccess, DataHandle, RunResult } from './data-access';

/**
 * The raw query surface shared by the root ORM client and an interactive
 * transaction client. Keeping it structural avoids leaking generated-model
 * types into the temporary facade, which is deleted in Finalize.
 */
interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Whether a write failed on a unique constraint. Typed ORM writes report
 * Prisma's `P2002`; the facade's remaining raw statements are wrapped by the
 * driver adapter, whose error metadata still carries PostgreSQL's SQLSTATE
 * `23505`. The unique constraint is the race-free arbiter for "this value is
 * already taken", so callers treat any such violation — including a lost race
 * — as the same refusal.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const shape = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    shape.code === 'P2002' ||
    shape.code === '23505' ||
    shape.meta?.driverAdapterError?.cause?.originalCode === '23505'
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
 * first row or every row. Deleted in Finalize.
 */
export class PrismaRawAccess implements DataAccess {
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

  transaction<T>(_fn: (tx: DataHandle) => Promise<T>): Promise<T> {
    return Promise.reject(new Error('nested transactions are not supported'));
  }
}

/**
 * The handle an interactive transaction callback receives: the facade's raw
 * methods bound to the transaction, plus the typed models a converted caller
 * may reach. The proxy forwards everything the facade does not define to the
 * transaction client itself; it exists only while both surfaces coexist and
 * is deleted with the facade in Finalize.
 */
export function transactionHandle(tx: Prisma.TransactionClient): DataHandle {
  const facade = new PrismaRawAccess(tx);
  return new Proxy(facade, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      const value = Reflect.get(tx as object, property, tx);
      return typeof value === 'function' ? value.bind(tx) : value;
    },
  }) as unknown as DataHandle;
}
