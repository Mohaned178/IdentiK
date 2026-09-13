import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { DataAccess, DataHandle, RunResult } from './data-access';
import { PrismaRawAccess, transactionHandle } from './postgres';

/** The one documented way an Instance Operator brings the schema up to date. */
const MIGRATE_COMMAND = 'npx prisma migrate deploy';

/**
 * Read and validate the Instance's persistence configuration. The database
 * URL is the only storage setting; it must be present and an absolute
 * PostgreSQL URL with a host and a database name before any connection is
 * attempted.
 */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set to the PostgreSQL connection URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL must be an absolute PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme');
  }
  if (parsed.hostname.length === 0) {
    throw new Error('DATABASE_URL must name a PostgreSQL host');
  }
  if (parsed.pathname.length <= 1) {
    throw new Error('DATABASE_URL must name a database');
  }
  return url;
}

/** Whether a raw statement failed because the table it names does not exist. */
function isUndefinedTable(error: unknown): boolean {
  const shape = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    shape.code === '42P01' || shape.meta?.driverAdapterError?.cause?.originalCode === '42P01'
  );
}

/**
 * Migrations are an explicit deploy step: the Instance never creates or
 * changes the schema at boot. A database that is empty, unmigrated, or missing
 * the bookkeeping table fails startup with the command to run; a connectivity
 * or permission failure surfaces as itself instead of masquerading as one.
 */
async function assertSchemaPresent(prisma: PrismaClient): Promise<void> {
  try {
    const applied = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM "_prisma_migrations"',
    );
    if ((applied[0]?.count ?? 0) > 0) {
      await prisma.$queryRawUnsafe('SELECT 1 FROM organizations LIMIT 1');
      return;
    }
  } catch (error) {
    if (!(error instanceof Error) || !isUndefinedTable(error)) throw error;
  }
  throw new Error(
    `the Instance database is not migrated; run "${MIGRATE_COMMAND}" ` +
      'against DATABASE_URL before starting',
  );
}

/**
 * The Instance's injected data client: one ORM client on the PostgreSQL driver
 * adapter, provided through the `DATABASE` token. It owns the connection pool
 * and the startup schema check, and disconnects when the Instance shuts down.
 * The facade methods below are the temporary Stage 1 compatibility surface
 * (ADR-0026, ADR-0027) that unconverted modules still call; Stage 2 deletes
 * them module by module until Finalize removes the last of them.
 */
@Injectable()
export class PrismaService extends PrismaClient implements DataAccess, OnModuleInit, OnModuleDestroy {
  private readonly raw = new PrismaRawAccess(this);

  constructor() {
    super({ adapter: new PrismaPg({ connectionString: databaseUrl() }) });
  }

  async onModuleInit(): Promise<void> {
    await assertSchemaPresent(this);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    return this.raw.run(sql, params);
  }

  get<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | undefined> {
    return this.raw.get<T>(sql, params);
  }

  all<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    return this.raw.all<T>(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.raw.exec(sql);
  }

  transaction<T>(fn: (tx: DataHandle) => Promise<T>): Promise<T> {
    // SQLite let a unit of work run as long as it needed on the one
    // connection; the interactive transaction's defaults (5s timeout, 2s wait
    // for a connection) would be a new failure mode for large cascades. Keep
    // both generous until Stage 2 revisits transaction policy.
    return this.$transaction((tx) => fn(transactionHandle(tx)), {
      maxWait: 10_000,
      timeout: 30_000,
    });
  }
}
