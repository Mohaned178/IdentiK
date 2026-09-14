import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '../generated/prisma/client';

/** The command that brings a database up to this release's schema. */
const MIGRATE_COMMAND = 'npx prisma migrate deploy';

/**
 * Where a release artifact keeps the migrations this server was built with.
 * The tarball lays out `dist/` and `prisma/` side by side, so the compiled
 * file's own location is the anchor — never the process's working directory.
 */
const SHIPPED_MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

class MigrationGateError extends Error {}

/** Whether a statement failed because the table it names does not exist. */
function isUndefinedTable(error: unknown): boolean {
  const shape = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return shape.code === '42P01' || shape.meta?.driverAdapterError?.cause?.originalCode === '42P01';
}

/**
 * The migration names this artifact ships, read from its `prisma/migrations`
 * directory. A release without that directory — or with it empty — cannot
 * know whether the database matches the code it carries, so it is broken
 * loudly rather than allowed to serve.
 */
function shippedMigrationNames(): string[] {
  let entries;
  try {
    entries = readdirSync(SHIPPED_MIGRATIONS_DIR, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MigrationGateError(
        `this release is missing its migrations directory (${SHIPPED_MIGRATIONS_DIR}); ` +
          'ship the prisma/ directory with the server so the database can be checked.',
      );
    }
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new MigrationGateError(
      `this release ships an empty migrations directory (${SHIPPED_MIGRATIONS_DIR}); ` +
        'the Instance cannot verify the database schema against it.',
    );
  }
  return names;
}

/** The migrations the database records as applied and not rolled back. */
async function appliedMigrationNames(prisma: PrismaClient): Promise<Set<string>> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    return new Set(rows.map((row) => row.migration_name));
  } catch (error) {
    // No bookkeeping table means nothing has ever been deployed here.
    if (isUndefinedTable(error)) return new Set();
    throw error;
  }
}

/**
 * The startup schema gate. The server never applies migrations — deploying
 * the schema is an explicit one-off command — but it refuses to serve against
 * a database behind the release, naming the command to run. A database ahead
 * of the release (an applied migration this artifact has never heard of) is
 * tolerated so a rollback across additive migrations stays safe. A
 * connectivity or permission failure surfaces as itself rather than
 * masquerading as a stale schema.
 *
 * This startup probe is the one raw-SQL site outside the two documented
 * exception classes (ADR-0027): it checks Prisma's own bookkeeping, which no
 * model represents, and is infrastructure rather than a data-access path.
 */
export async function assertDatabaseMatchesRelease(prisma: PrismaClient): Promise<void> {
  const shipped = shippedMigrationNames();
  const applied = await appliedMigrationNames(prisma);
  const pending = shipped.filter((name) => !applied.has(name));
  if (pending.length > 0) {
    throw new MigrationGateError(
      `the Instance database is behind this release ` +
        `(unapplied migrations: ${pending.join(', ')}); run "${MIGRATE_COMMAND}" ` +
        'against DATABASE_URL before starting the server.',
    );
  }
  // Bookkeeping can only vouch for a schema that is actually present.
  try {
    await prisma.$queryRaw`SELECT 1 FROM organizations LIMIT 1`;
  } catch (error) {
    if (!isUndefinedTable(error)) throw error;
    throw new MigrationGateError(
      `the Instance database is missing its core schema; run "${MIGRATE_COMMAND}" ` +
        'against DATABASE_URL before starting the server.',
    );
  }
}
