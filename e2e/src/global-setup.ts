import { dropTemplateDatabase, provisionTemplateDatabase } from './provision';

/**
 * One migrated template database per test run: created, brought to the
 * baseline by `prisma migrate deploy`, and cloned by every Instance. The
 * workers only clone from it, never migrate.
 */
export async function setup(): Promise<void> {
  await provisionTemplateDatabase();
}

export async function teardown(): Promise<void> {
  await dropTemplateDatabase();
}
