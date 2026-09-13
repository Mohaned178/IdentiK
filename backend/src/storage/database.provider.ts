import { Provider } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaDatabase } from './postgres';
import { DATABASE, type Database } from './token';

/** The one documented way an Operator brings the schema up to date. */
const MIGRATE_COMMAND = 'prisma migrate deploy';

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
 * Provides the Instance's data handle: a single ORM client on the PostgreSQL
 * driver adapter, wrapped in the Stage 1 facade. Organization-owned tables are
 * Organization-scoped from day one (ADR-0001); platform-population tables
 * (administrators, their sessions) are Instance-global per ADR-0002/0021.
 */
export const databaseProvider: Provider = {
  provide: DATABASE,
  useFactory: async (): Promise<Database> => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl() }),
    });
    await assertSchemaPresent(prisma);
    return new PrismaDatabase(prisma);
  },
};
