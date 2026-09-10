import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE administrators (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE memberships (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        administrator_id TEXT NOT NULL REFERENCES administrators(id),
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        UNIQUE (organization_id, administrator_id)
      )`);
      db.exec(`CREATE TABLE admin_sessions (
        id TEXT PRIMARY KEY,
        membership_id TEXT NOT NULL REFERENCES memberships(id),
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`);
      db.exec(`CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id),
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE instance_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
    },
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
