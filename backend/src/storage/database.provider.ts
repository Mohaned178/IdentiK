import { Provider } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { migrate } from './migrate';
import { SqliteDatabase } from './sqlite';
import { DATABASE, type Database } from './token';

/**
 * Opens (or creates) the Instance's SQLite database under the state dir, runs
 * migrations, and wraps it in the Stage 1 data-access facade. Organization-
 * owned tables are Organization-scoped from day one (ADR-0001); platform-
 * population tables (administrators, their sessions) are Instance-global per
 * ADR-0002/0021.
 */
export const databaseProvider: Provider = {
  provide: DATABASE,
  useFactory: (): Database => {
    const stateDir = process.env.IDENTIK_STATE_DIR;
    if (!stateDir || !isAbsolute(stateDir)) {
      throw new Error('IDENTIK_STATE_DIR must be set to an absolute path');
    }
    mkdirSync(stateDir, { recursive: true });
    const db = new DatabaseSync(join(stateDir, 'identik.db'));
    migrate(db);
    return new SqliteDatabase(db);
  },
};
