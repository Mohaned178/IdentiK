import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

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

/** Whether a statement failed because the table it names does not exist. */
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
 *
 * This startup probe is the one raw-SQL site outside the two documented
 * exception classes (ADR-0027): it checks Prisma's own bookkeeping, which no
 * model represents, and is infrastructure rather than a data-access path.
 */
async function assertSchemaPresent(prisma: PrismaClient): Promise<void> {
  try {
    const applied = await prisma.$queryRaw<
      Array<{ count: number }>
    >`SELECT COUNT(*)::int AS count FROM "_prisma_migrations"`;
    if ((applied[0]?.count ?? 0) > 0) {
      await prisma.$queryRaw`SELECT 1 FROM organizations LIMIT 1`;
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
 * adapter, provided through the `DATABASE` token (ADR-0026, ADR-0027). It owns
 * the connection pool and the startup schema check, and disconnects when the
 * Instance shuts down. Services use typed models and `$transaction`; the two
 * documented raw exceptions live where they are used.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: databaseUrl() }),
      // SQLite let a unit of work run as long as it needed on its one
      // connection; Prisma's defaults (5s timeout, 2s wait for a connection)
      // would be a new failure mode for large cascades such as a revoke-all.
      // The client-wide budget preserves the Stage 1 facade's policy for every
      // interactive transaction without a per-call wrapper.
      transactionOptions: { maxWait: 10_000, timeout: 30_000 },
    });
  }

  async onModuleInit(): Promise<void> {
    await assertSchemaPresent(this);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
