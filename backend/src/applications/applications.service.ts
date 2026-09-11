import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { hashToken, randomToken } from '../crypto/password';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { SessionsService } from '../sessions/sessions.service';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';
import {
  applicationState,
  deletedApplicationPseudonym,
  type ApplicationState,
} from './application-state';
import { validateRedirectUri } from './redirect-uri';

export type ApplicationType = 'web' | 'spa';

export interface SecretView {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface RedirectUriView {
  id: string;
  uri: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface ApplicationView {
  id: string;
  name: string;
  type: ApplicationType;
  clientId: string;
  state: ApplicationState;
  createdAt: string;
  secrets: SecretView[];
  redirectUris: RedirectUriView[];
}

/** What the authorization endpoint needs to know about a client. */
export interface AuthorizeClient {
  id: string;
  clientId: string;
  organizationId: string;
  organizationName: string;
  name: string;
  type: ApplicationType;
  enabled: boolean;
  redirectUris: string[];
}

/** What the token surface needs to know about a client. */
export interface ClientRecord {
  id: string;
  clientId: string;
  organizationId: string;
  type: ApplicationType;
  enabled: boolean;
}

interface ApplicationRow {
  id: string;
  name: string;
  type: ApplicationType;
  client_id: string;
  disabled_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface SecretRow {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

interface RedirectUriRow {
  id: string;
  uri: string;
  created_at: string;
  updated_at: string | null;
}

/**
 * The Application and Client credential lifecycle (ADR-0009, ADR-0010). A Web
 * Application is a confidential client; its Client Secret is generated here,
 * returned to the caller exactly once, and stored verifiable-only — no method
 * on this service (and therefore no HTTP path) can read a secret back. A
 * SPA/Mobile Application is a public client and is refused a secret on every
 * path. Multiple labeled secrets coexist per Application and are revoked
 * individually, so rotation needs no downtime.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly enrollments: EnrollmentsService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Register an Application. A Web Application additionally receives its first
   * Client Secret, shown once in the returned `clientSecret`.
   */
  register(input: {
    organizationId: string;
    actor: string;
    name: string;
    type: ApplicationType;
  }): { application: ApplicationView; clientSecret: string | null } {
    const name = input.name.trim();
    if (name.length === 0) throw new BadRequestException('an Application name is required');
    const id = uuid();
    const clientId = randomToken(16);
    const now = new Date().toISOString();

    // Registration and the confidential client's first secret are one unit:
    // a Web Application must never exist without the credential that makes it
    // useful, and a failed issuance must not leave a half-registered row.
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO applications (id, organization_id, name, type, client_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.organizationId, name, input.type, clientId, input.actor, now);

      this.audit(input.organizationId, input.actor, 'application.registered', {
        applicationId: id,
        name,
        type: input.type,
        clientId,
      });

      let clientSecret: string | null = null;
      if (input.type === 'web') {
        clientSecret = this.issueSecret({
          organizationId: input.organizationId,
          applicationId: id,
          actor: input.actor,
          label: 'default',
        }).clientSecret;
      }
      this.db.exec('COMMIT');
      return { application: this.view(input.organizationId, id), clientSecret };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(organizationId: string): ApplicationView[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, type, client_id, disabled_at, deleted_at, created_at FROM applications
         WHERE organization_id = ? ORDER BY created_at`,
      )
      .all(organizationId) as unknown as ApplicationRow[];
    return rows.map((row) => this.toView(row));
  }

  find(organizationId: string, id: string): ApplicationView {
    return this.view(organizationId, id);
  }

  /**
   * Pause an Application (ADR-0007): new authentication is refused and every
   * refresh token minted through its flows is revoked immediately, while the
   * platform Sessions survive — a pause is not credential revocation, so the
   * Client Secrets stay valid. Reversible via `enable`; idempotent.
   */
  disable(input: { organizationId: string; applicationId: string; actor: string }): ApplicationView {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    if (application.deleted_at !== null) return this.view(input.organizationId, application.id);

    const now = new Date().toISOString();
    // State change, revocation, and audit are one unit: a paused Application
    // whose app-minted tokens outlive the pause is the lie disable exists to
    // prevent.
    this.db.exec('BEGIN');
    try {
      const changed = this.db
        .prepare(
          'UPDATE applications SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL',
        )
        .run(now, application.id);
      if (Number(changed.changes) === 1) {
        const refreshTokensRevoked = this.sessions.revokeRefreshTokensForApplication(application.id);
        this.audit(input.organizationId, input.actor, 'application.disabled', {
          applicationId: application.id,
          name: application.name,
          refreshTokensRevoked,
        });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.view(input.organizationId, application.id);
  }

  /** Reverse the pause. Revoked refresh tokens stay dead (ADR-0007). */
  enable(input: { organizationId: string; applicationId: string; actor: string }): ApplicationView {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    if (application.deleted_at !== null) return this.view(input.organizationId, application.id);

    const changed = this.db
      .prepare(
        'UPDATE applications SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL AND deleted_at IS NULL',
      )
      .run(application.id);
    if (Number(changed.changes) === 1) {
      this.audit(input.organizationId, input.actor, 'application.enabled', {
        applicationId: application.id,
        name: application.name,
      });
    }
    return this.view(input.organizationId, application.id);
  }

  /**
   * Delete an Application — irreversible (ADR-0007). Enrollments are removed,
   * Client Secrets and app-minted refresh tokens are revoked, and the
   * Application's name is destroyed and pseudonymized in both the row and its
   * surviving audit trail. Identities are never touched: the Organization owns
   * them, so even Identities left with no Enrollments survive. Idempotent.
   */
  remove(input: { organizationId: string; applicationId: string; actor: string }): ApplicationView {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    if (application.deleted_at !== null) return this.view(input.organizationId, application.id);

    const now = new Date().toISOString();
    const pseudonym = deletedApplicationPseudonym(application.id);

    this.db.exec('BEGIN');
    try {
      // The terminal marker is the race-free arbiter: a concurrent second
      // delete rolls back without duplicating the event or re-pseudonymizing.
      const marked = this.db
        .prepare(
          'UPDATE applications SET name = ?, disabled_at = COALESCE(disabled_at, ?), deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
        )
        .run(pseudonym, now, now, application.id);
      if (Number(marked.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return this.view(input.organizationId, application.id);
      }
      const secrets = this.db
        .prepare(
          `UPDATE client_secrets SET revoked_at = ?, revoked_by = ?
            WHERE application_id = ? AND revoked_at IS NULL`,
        )
        .run(now, input.actor, application.id);
      const refreshTokensRevoked = this.sessions.revokeRefreshTokensForApplication(application.id);
      const enrollmentsRemoved = this.enrollments.removeAllForApplication(application.id);
      // The durable key is the applicationId; the human-facing name in
      // historical details is PII, so the surviving trail is re-attributed to
      // the pseudonymous shell.
      this.db
        .prepare(
          `UPDATE audit_events SET detail = json_set(detail, '$.name', ?)
            WHERE organization_id = ?
              AND json_extract(detail, '$.applicationId') = ?
              AND json_extract(detail, '$.name') IS NOT NULL`,
        )
        .run(pseudonym, input.organizationId, application.id);
      this.audit(input.organizationId, input.actor, 'application.deleted', {
        applicationId: application.id,
        pseudonym,
        enrollmentsRemoved,
        secretsRevoked: Number(secrets.changes),
        refreshTokensRevoked,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.view(input.organizationId, application.id);
  }

  /**
   * Resolve a Client ID at the authorization boundary, with the Organization
   * it belongs to and the exact-match redirect URI list. Returns undefined for
   * an unknown client; the caller decides how to refuse without leaking which
   * part was wrong.
   */
  findForAuthorization(clientId: string): AuthorizeClient | undefined {
    const row = this.db
      .prepare(
        `SELECT a.id, a.client_id, a.organization_id, a.name, a.type, a.disabled_at, a.deleted_at,
                o.name AS organization_name
         FROM applications a JOIN organizations o ON o.id = a.organization_id
         WHERE a.client_id = ?`,
      )
      .get(clientId) as
      | {
          id: string;
          client_id: string;
          organization_id: string;
          organization_name: string;
          name: string;
          type: ApplicationType;
          disabled_at: string | null;
          deleted_at: string | null;
        }
      | undefined;
    if (!row) return undefined;

    const redirectUris = this.db
      .prepare(
        'SELECT uri FROM redirect_uris WHERE application_id = ? ORDER BY created_at, id',
      )
      .all(row.id) as unknown as Array<{ uri: string }>;
    return {
      id: row.id,
      clientId: row.client_id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      name: row.name,
      type: row.type,
      enabled: this.isUsable(row),
      redirectUris: redirectUris.map((entry) => entry.uri),
    };
  }

  /** Resolve a Client ID at the token boundary; no redirect URIs needed there. */
  findClient(clientId: string): ClientRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, client_id, organization_id, type, disabled_at, deleted_at FROM applications WHERE client_id = ?',
      )
      .get(clientId) as
      | {
          id: string;
          client_id: string;
          organization_id: string;
          type: ApplicationType;
          disabled_at: string | null;
          deleted_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      clientId: row.client_id,
      organizationId: row.organization_id,
      type: row.type,
      enabled: this.isUsable(row),
    };
  }

  /**
   * Whether a presented Client Secret is one of the Application's currently
   * valid concurrent secrets (ADR-0010). Revocation applies immediately: a
   * revoked secret simply is not in the active set any more. Secrets are
   * high-entropy, so comparing their stored hashes is the verification.
   */
  verifyClientSecret(applicationId: string, secret: string): boolean {
    const presented = Buffer.from(hashToken(secret));
    const hashes = this.db
      .prepare(
        'SELECT secret_hash FROM client_secrets WHERE application_id = ? AND revoked_at IS NULL',
      )
      .all(applicationId) as unknown as Array<{ secret_hash: string }>;
    for (const row of hashes) {
      const stored = Buffer.from(row.secret_hash);
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) return true;
    }
    return false;
  }

  /**
   * Issue an additional labeled Client Secret for a Web Application, returning
   * the plaintext once. Public clients are structurally refused.
   */
  issueSecret(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
    label: string;
  }): { secret: SecretView; clientSecret: string } {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    if (application.type !== 'web') {
      throw new BadRequestException(
        'a SPA/Mobile Application is never issued a Client Secret',
      );
    }

    const secretId = uuid();
    const clientSecret = randomToken(32);
    const label = input.label.trim();
    if (label.length === 0) throw new BadRequestException('a Client Secret label is required');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO client_secrets (id, application_id, label, secret_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(secretId, input.applicationId, label, hashToken(clientSecret), input.actor, now);

    this.audit(input.organizationId, input.actor, 'client_secret.generated', {
      applicationId: input.applicationId,
      secretId,
      label,
    });

    return { secret: { id: secretId, label, createdAt: now, revokedAt: null }, clientSecret };
  }

  /**
   * Revoke one secret by id, leaving every sibling untouched. Idempotent: a
   * second revoke of a dead secret is not an error, it simply changes nothing.
   */
  revokeSecret(input: {
    organizationId: string;
    applicationId: string;
    secretId: string;
    actor: string;
  }): SecretView {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    const row = this.db
      .prepare('SELECT id, label, created_at, revoked_at FROM client_secrets WHERE id = ? AND application_id = ?')
      .get(input.secretId, application.id) as SecretRow | undefined;
    if (!row) throw new NotFoundException('no such Client Secret');

    if (row.revoked_at === null) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE client_secrets SET revoked_at = ?, revoked_by = ?
           WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(now, input.actor, input.secretId);
      this.audit(input.organizationId, input.actor, 'client_secret.revoked', {
        applicationId: application.id,
        secretId: input.secretId,
        label: row.label,
      });
      row.revoked_at = now;
    }

    return { id: row.id, label: row.label, createdAt: row.created_at, revokedAt: row.revoked_at };
  }

  /**
   * Add a redirect URI (ADR-0010). The value is validated into its canonical
   * absolute form and then stored verbatim: the exact-match target the
   * authorization endpoint will later compare against. Duplicates are refused
   * so a URI has at most one identity per Application.
   */
  addRedirectUri(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
    uri: string;
  }): RedirectUriView {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    const uri = validateRedirectUri(input.uri);
    this.refuseDuplicateRedirectUri(application.id, uri);

    const id = uuid();
    const now = new Date().toISOString();
    // The change and its audit event are one unit: a persisted redirect URI
    // with no event beside it is the silent code-interception primitive
    // ADR-0010 exists to prevent.
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO redirect_uris (id, application_id, uri, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, application.id, uri, input.actor, now);
      this.audit(input.organizationId, input.actor, 'redirect_uri.added', {
        applicationId: application.id,
        uriId: id,
        uri,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, uri, createdAt: now, updatedAt: null };
  }

  /**
   * Replace a redirect URI's value. Validation and the duplicate rule are the
   * same as for an addition; the prior value rides along in the audit event so
   * the exact change is answerable after the fact.
   */
  updateRedirectUri(input: {
    organizationId: string;
    applicationId: string;
    uriId: string;
    actor: string;
    uri: string;
  }): RedirectUriView {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    const row = this.requireRedirectUri(application.id, input.uriId);
    const uri = validateRedirectUri(input.uri);
    if (uri === row.uri) return this.redirectUriView(row);

    this.refuseDuplicateRedirectUri(application.id, uri, row.id);
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('UPDATE redirect_uris SET uri = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(uri, input.actor, now, row.id);
      this.audit(input.organizationId, input.actor, 'redirect_uri.updated', {
        applicationId: application.id,
        uriId: row.id,
        previousUri: row.uri,
        uri,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id: row.id, uri, createdAt: row.created_at, updatedAt: now };
  }

  /** Remove a redirect URI. There is no prefix or wildcard echo to clean up. */
  removeRedirectUri(input: {
    organizationId: string;
    applicationId: string;
    uriId: string;
    actor: string;
  }): RedirectUriView {
    const application = this.requireApplication(input.organizationId, input.applicationId);
    const row = this.requireRedirectUri(application.id, input.uriId);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM redirect_uris WHERE id = ? AND application_id = ?')
        .run(row.id, application.id);
      this.audit(input.organizationId, input.actor, 'redirect_uri.removed', {
        applicationId: application.id,
        uriId: row.id,
        uri: row.uri,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.redirectUriView(row);
  }

  private requireRedirectUri(applicationId: string, uriId: string): RedirectUriRow {
    const row = this.db
      .prepare(
        'SELECT id, uri, created_at, updated_at FROM redirect_uris WHERE id = ? AND application_id = ?',
      )
      .get(uriId, applicationId) as RedirectUriRow | undefined;
    if (!row) throw new NotFoundException('no such redirect URI');
    return row;
  }

  private refuseDuplicateRedirectUri(applicationId: string, uri: string, exceptId?: string): void {
    const duplicate = exceptId
      ? this.db
          .prepare('SELECT id FROM redirect_uris WHERE application_id = ? AND uri = ? AND id <> ?')
          .get(applicationId, uri, exceptId)
      : this.db
          .prepare('SELECT id FROM redirect_uris WHERE application_id = ? AND uri = ?')
          .get(applicationId, uri);
    if (duplicate) throw new ConflictException('this redirect URI is already registered');
  }

  private redirectUriView(row: RedirectUriRow): RedirectUriView {
    return {
      id: row.id,
      uri: row.uri,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Whether the Application may mint new authentication and tokens at all. */
  private isUsable(row: { disabled_at: string | null; deleted_at: string | null }): boolean {
    return row.disabled_at === null && row.deleted_at === null;
  }

  private requireApplication(organizationId: string, id: string): ApplicationRow {
    const row = this.db
      .prepare(
        'SELECT id, name, type, client_id, disabled_at, deleted_at, created_at FROM applications WHERE id = ? AND organization_id = ?',
      )
      .get(id, organizationId) as ApplicationRow | undefined;
    if (!row) throw new NotFoundException('no such Application');
    return row;
  }

  private view(organizationId: string, id: string): ApplicationView {
    return this.toView(this.requireApplication(organizationId, id));
  }

  private toView(row: ApplicationRow): ApplicationView {
    const secrets = this.db
      .prepare(
        'SELECT id, label, created_at, revoked_at FROM client_secrets WHERE application_id = ? ORDER BY created_at, id',
      )
      .all(row.id) as unknown as SecretRow[];
    const redirectUris = this.db
      .prepare(
        'SELECT id, uri, created_at, updated_at FROM redirect_uris WHERE application_id = ? ORDER BY created_at, id',
      )
      .all(row.id) as unknown as RedirectUriRow[];
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      clientId: row.client_id,
      state: applicationState({
        disabled: row.disabled_at !== null,
        deleted: row.deleted_at !== null,
      }),
      createdAt: row.created_at,
      secrets: secrets.map((secret) => ({
        id: secret.id,
        label: secret.label,
        createdAt: secret.created_at,
        revokedAt: secret.revoked_at,
      })),
      redirectUris: redirectUris.map((entry) => this.redirectUriView(entry)),
    };
  }

  private audit(
    organizationId: string,
    actor: string,
    kind: string,
    detail: Record<string, unknown>,
  ): void {
    recordAuditEvent(this.db, { organizationId, actor, kind, detail });
  }
}
