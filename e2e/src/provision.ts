import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BACKEND_DIR = join(WORKSPACE_ROOT, 'backend');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');

/**
 * The administrative connection the harness uses for create/drop/clone. It is
 * provisioning only: the harness never reads or writes an Instance's tables.
 * The conventional local server is the default so a developer needs only a
 * running PostgreSQL 18 and no configuration; CI points this at its service.
 */
export const ADMIN_URL =
  process.env.IDENTIK_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

/**
 * The already-migrated database every Instance database is cloned from. The
 * name carries the run id minted by global setup so concurrent runs against
 * one server never share a template; outside the suite the id is absent and
 * the name is a stable default.
 */
export function templateDatabase(): string {
  return `identik_e2e_template_${process.env.IDENTIK_E2E_RUN_ID ?? 'default'}`;
}

function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`invalid database identifier: ${name}`);
  }
  return `"${name}"`;
}

/** The connection URL an Instance uses for its own database. */
export function databaseUrl(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A short, stable database name for an opaque test key (unique per start). */
export function databaseNameFor(key: string): string {
  return `identik_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/** The admin URL without its password, safe to put in an error message. */
function redactedAdminUrl(): string {
  const url = new URL(ADMIN_URL);
  if (url.password) url.password = '***';
  return url.toString();
}

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `could not reach the test PostgreSQL server at ${redactedAdminUrl()}; ` +
        'start PostgreSQL 18 or point IDENTIK_TEST_DATABASE_URL at it',
      { cause: error },
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Drops are forced so a killed Instance's lingering connections cannot block
 * teardown; a database that is already gone is not an error.
 */
function dropIfExists(client: Client, database: string): Promise<unknown> {
  return client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
}

/**
 * The one-off deploy step, run the way an operator runs it: `prisma migrate
 * deploy` from a directory that carries `prisma.config.ts` and its
 * `prisma/migrations` tree. The server itself never migrates.
 */
export function migrateWithArtifact(artifactRoot: string, database: string): void {
  try {
    execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      cwd: artifactRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl(database) },
      stdio: 'pipe',
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(
      `"prisma migrate deploy" failed for database ${database}` + (stderr ? `:\n${stderr}` : ''),
      { cause: error },
    );
  }
}

/** The migration names the built backend ships, oldest first, newest last. */
export function shippedMigrationNames(): string[] {
  return readdirSync(join(BACKEND_DIR, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Build this run's migrated template: a fresh database brought up by the one
 * documented command. Instances clone it, so each starts already migrated
 * without paying a migration, exactly as a fresh state directory used to.
 */
export async function provisionTemplateDatabase(): Promise<void> {
  const template = templateDatabase();
  await recreateDatabase(template);
  migrateWithArtifact(BACKEND_DIR, template);
}

/**
 * A release artifact laid out the way the tarball is: the compiled server in
 * `dist/` beside the `prisma/` tree the startup migration gate reads.
 */
export interface ReleaseArtifact {
  readonly root: string;
  readonly dist: string;
}

/**
 * Copies the built backend into a throwaway directory so a test can hand the
 * Instance an older or broken release without touching the working tree.
 * `omitMigrations` makes the artifact older than a database provisioned from
 * the full set; `withoutMigrations` models a release that shipped without its
 * migrations directory. The workspace's installed dependencies are linked in,
 * the role `npm ci --omit=dev` plays for a deployed install.
 */
export function copyReleaseArtifact(
  options: { omitMigrations?: readonly string[]; withoutMigrations?: boolean } = {},
): ReleaseArtifact {
  const root = mkdtempSync(join(tmpdir(), 'identik-artifact-'));
  cpSync(join(BACKEND_DIR, 'dist'), join(root, 'dist'), { recursive: true });
  cpSync(join(BACKEND_DIR, 'prisma'), join(root, 'prisma'), { recursive: true });
  cpSync(join(BACKEND_DIR, 'prisma.config.ts'), join(root, 'prisma.config.ts'));
  cpSync(join(BACKEND_DIR, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(WORKSPACE_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
  const migrations = join(root, 'prisma', 'migrations');
  if (options.withoutMigrations) {
    rmSync(migrations, { recursive: true, force: true });
  } else {
    for (const name of options.omitMigrations ?? []) {
      rmSync(join(migrations, name), { recursive: true, force: true });
    }
  }
  return { root, dist: join(root, 'dist') };
}

export function disposeReleaseArtifact(artifact: ReleaseArtifact): void {
  rmSync(artifact.root, { recursive: true, force: true });
}

/** Drops any database of this name and creates a fresh, empty one. */
async function recreateDatabase(database: string): Promise<void> {
  await withAdminClient(async (client) => {
    await dropIfExists(client, database);
    await client.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
  });
}

/**
 * A fresh, empty database — the state before the first migration. Used to
 * provision an earlier migration state through the one-off deploy step.
 */
export async function createEmptyDatabase(database: string): Promise<void> {
  await recreateDatabase(database);
}

export async function dropTemplateDatabase(): Promise<void> {
  await withAdminClient((client) => dropIfExists(client, templateDatabase()));
}

/**
 * A fresh clone of the migrated template for a new Instance, or the existing
 * database when the key has been used before — a restart against the same
 * storage, which is how durability is tested.
 */
export async function ensureDatabase(database: string): Promise<void> {
  await withAdminClient(async (client) => {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount) return;
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(templateDatabase())}`,
    );
  });
}

export async function dropDatabase(database: string): Promise<void> {
  await withAdminClient((client) => dropIfExists(client, database));
}
