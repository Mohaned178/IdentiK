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
  {
    version: 2,
    up: (db) => {
      // ADR-0004: one Identity per person per Organization, credentials on the
      // Identity. ADR-0005: email uniquely identifies it within the
      // Organization (stored normalized; NOCASE collation is the backstop).
      db.exec(`CREATE TABLE identities (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL COLLATE NOCASE,
        email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (organization_id, email)
      )`);
      // ADR-0011: one mailbox-proof concept, two entry points — the
      // verification link (ticket 03) and the password-reset link (ticket 04)
      // both land here. Single-use, expiring, stored verifiable-only.
      db.exec(`CREATE TABLE identity_tokens (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES identities(id),
        kind TEXT NOT NULL CHECK (kind IN ('email_verification', 'password_reset')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      )`);
    },
  },
  {
    version: 3,
    up: (db) => {
      // ADR-0013: a password reset is a security event that revokes every
      // Session of the Identity. Sessions themselves arrive in ticket 09; the
      // watermark lives on the Identity now so any Session created at or
      // before it is treated as revoked, and so a reset can never be undone by
      // a Session that predates it.
      db.exec('ALTER TABLE identities ADD COLUMN sessions_revoked_at TEXT');
    },
  },
  {
    version: 4,
    up: (db) => {
      // ADR-0021: after bootstrap, Owners invite Administrators by email; the
      // invitee sets their own password. The invitation is a single-use,
      // expiring, stored-verifiable-only token bound to an Organization and a
      // role (the Membership the invitee will receive). The inviter never
      // chooses a credential, so no password material lives here.
      db.exec(`CREATE TABLE administrator_invitations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        token_hash TEXT NOT NULL UNIQUE,
        invited_by TEXT NOT NULL REFERENCES administrators(id),
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        expiry_audited_at TEXT,
        created_at TEXT NOT NULL
      )`);
    },
  },
  {
    version: 5,
    up: (db) => {
      // ADR-0009: an Application belongs to exactly one Organization forever
      // and is either a Web (confidential) or SPA/Mobile (public) client.
      // The Client ID is public and permanent (ADR-0010) — it appears in URLs
      // and logs, so it is generated once at registration and never rotated.
      db.exec(`CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('web', 'spa')),
        client_id TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES administrators(id),
        created_at TEXT NOT NULL
      )`);
      // ADR-0010: Client Secrets are stored verifiable-only (no read-back
      // path), displayed exactly once at generation, and support multiple
      // concurrent labeled, timestamped secrets with individual revocation so
      // rotation is zero-downtime. A public client never gets a row here.
      db.exec(`CREATE TABLE client_secrets (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id),
        label TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES administrators(id),
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT REFERENCES administrators(id)
      )`);
    },
  },
  {
    version: 6,
    up: (db) => {
      // ADR-0010: a redirect URI is one concrete, absolute URL — HTTPS, or
      // plain HTTP for loopback development only — matched exactly on scheme +
      // host + port + path. The unique constraint makes the exact-match target
      // unambiguous per Application; wildcard/prefix forms never enter here
      // because the configuration API refuses them before insert.
      db.exec(`CREATE TABLE redirect_uris (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id),
        uri TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES administrators(id),
        created_at TEXT NOT NULL,
        updated_by TEXT REFERENCES administrators(id),
        updated_at TEXT,
        UNIQUE (application_id, uri)
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
