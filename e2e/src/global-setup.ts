import { randomUUID } from 'node:crypto';
import { dropTemplateDatabase, provisionTemplateDatabase } from './provision';

/**
 * One migrated template database per test run: created, brought to the
 * baseline by `prisma migrate deploy`, and cloned by every Instance. The
 * workers only clone from it, never migrate. The run id is minted here and
 * inherited by the workers, so two runs sharing one PostgreSQL server cannot
 * drop or clone each other's template.
 */
export async function setup(): Promise<void> {
  process.env.IDENTIK_E2E_RUN_ID = randomUUID().slice(0, 8);
  await provisionTemplateDatabase();
}

export async function teardown(): Promise<void> {
  await dropTemplateDatabase();
}
