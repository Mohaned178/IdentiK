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
  {
    version: 7,
    up: (db) => {
      // ADR-0006: suspension is a state lever on the Identity and on the
      // Enrollment. The columns land with ticket 09's authentication gates;
      // ticket 13 adds the actions that set them.
      db.exec('ALTER TABLE identities ADD COLUMN suspended_at TEXT');
      db.exec(`CREATE TABLE enrollments (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES identities(id),
        application_id TEXT NOT NULL REFERENCES applications(id),
        created_at TEXT NOT NULL,
        suspended_at TEXT,
        UNIQUE (identity_id, application_id)
      )`);
      // ADR-0013: a Session is the durable record of one authentication — the
      // signed-in device. It parents the SSO cookie and, from ticket 10,
      // every refresh token minted through any Application's flow. The token
      // is stored verifiable-only; device metadata makes it recognizable.
      db.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES identities(id),
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        sso_token_hash TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`);
      // The authorization code ticket 09 issues and ticket 10 consumes:
      // single-use by the consumed_at arbiter, short-lived by expires_at,
      // bound to the Session whose child its refresh tokens will be, and
      // carrying the PKCE challenge and nonce the exchange will verify.
      db.exec(`CREATE TABLE authorization_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        application_id TEXT NOT NULL REFERENCES applications(id),
        identity_id TEXT NOT NULL REFERENCES identities(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        code_challenge TEXT,
        code_challenge_method TEXT,
        nonce TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )`);
    },
  },
  {
    version: 8,
    up: (db) => {
      // ADR-0013: a refresh token is a child of the Session whose authentication
      // minted it — never an independent credential. Stored verifiable-only,
      // single-use by the rotated_at arbiter (rotation on every use), and
      // expiring no later than its parent Session. Access tokens are
      // deliberately absent here: they are untracked signed JWTs that die
      // naturally within a short TTL.
      db.exec(`CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        application_id TEXT NOT NULL REFERENCES applications(id),
        identity_id TEXT NOT NULL REFERENCES identities(id),
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        rotated_at TEXT,
        revoked_at TEXT
      )`);
      db.exec('CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id)');
      db.exec('CREATE INDEX refresh_tokens_application_idx ON refresh_tokens(application_id)');
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
