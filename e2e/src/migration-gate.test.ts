import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendDistFromWorkspaceRoot,
  Instance,
  startupRefusal,
  WORKSPACE_ROOT,
} from './instance';
import {
  copyReleaseArtifact,
  createEmptyDatabase,
  databaseNameFor,
  disposeReleaseArtifact,
  dropDatabase,
  migrateWithArtifact,
  shippedMigrationNames,
  type ReleaseArtifact,
} from './provision';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

const LATEST_MIGRATION = shippedMigrationNames().at(-1)!;

/**
 * Ticket 04 — the startup migration gate. The server never migrates: the
 * harness provisions each database through the same one-off deploy step an
 * operator runs (`prisma migrate deploy` from an artifact's prisma tree), then
 * observes only the spawned Instance. Concurrent deploy attempts serialize on
 * Prisma's advisory lock; there is no boot-time migration to test.
 */
describe('the startup migration gate', () => {
  let olderArtifact: ReleaseArtifact;
  let brokenArtifact: ReleaseArtifact;

  beforeAll(() => {
    olderArtifact = copyReleaseArtifact({ omitMigrations: [LATEST_MIGRATION] });
    brokenArtifact = copyReleaseArtifact({ withoutMigrations: true });
  });

  afterAll(() => {
    disposeReleaseArtifact(olderArtifact);
    disposeReleaseArtifact(brokenArtifact);
  });

  it('refuses a database behind this release, naming the migration command', async () => {
    const key = `migration-behind-${Date.now()}`;
    const database = databaseNameFor(key);
    await createEmptyDatabase(database);
    migrateWithArtifact(olderArtifact.root, database);
    try {
      const message = await startupRefusal(Instance.startAt(BACKEND_DIST, key));
      expect(message).toMatch(/npx prisma migrate deploy/);
      expect(message).toContain(LATEST_MIGRATION);
    } finally {
      await dropDatabase(database);
    }
  });

  it('tolerates a database carrying a migration unknown to this release', async () => {
    const instance = await Instance.start(olderArtifact.dist);
    try {
      const res = await instance.request('/health/ready');
      expect(res.status).toBe(200);
    } finally {
      await instance.stop();
    }
  });

  it('fails loudly when the release ships without its migrations directory', async () => {
    const message = await startupRefusal(Instance.start(brokenArtifact.dist));
    expect(message).toMatch(/missing its migrations directory/);
  });

  it('refuses an unmigrated database and names the migration command', async () => {
    const key = `migration-unmigrated-${Date.now()}`;
    const database = databaseNameFor(key);
    await createEmptyDatabase(database);
    try {
      const message = await startupRefusal(Instance.startAt(BACKEND_DIST, key));
      expect(message).toMatch(/npx prisma migrate deploy/);
    } finally {
      await dropDatabase(database);
    }
  });
});
