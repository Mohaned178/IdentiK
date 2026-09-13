import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
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

/** The already-migrated database every Instance database is cloned from. */
export const TEMPLATE_DATABASE = 'identik_e2e_template';

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
 * Build this run's migrated template: a fresh database brought up by the one
 * documented command. Instances clone it, so each starts already migrated
 * without paying a migration, exactly as a fresh state directory used to.
 */
export async function provisionTemplateDatabase(): Promise<void> {
  await withAdminClient(async (client) => {
    await dropIfExists(client, TEMPLATE_DATABASE);
    await client.query(`CREATE DATABASE ${quoteIdentifier(TEMPLATE_DATABASE)}`);
  });
  try {
    execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl(TEMPLATE_DATABASE) },
      stdio: 'pipe',
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(
      `"prisma migrate deploy" failed while building the test template database` +
        (stderr ? `:\n${stderr}` : ''),
      { cause: error },
    );
  }
}

export async function dropTemplateDatabase(): Promise<void> {
  await withAdminClient((client) => dropIfExists(client, TEMPLATE_DATABASE));
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
      `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(TEMPLATE_DATABASE)}`,
    );
  });
}

export async function dropDatabase(database: string): Promise<void> {
  await withAdminClient((client) => dropIfExists(client, database));
}
