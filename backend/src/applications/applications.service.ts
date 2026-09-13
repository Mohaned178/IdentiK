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
import type { DataAccess, DataHandle } from '../storage/data-access';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';
import {
  applicationState,
  deletedApplicationPseudonym,
  type ApplicationState,
} from './application-state';
import { validateRedirectUri } from './redirect-uri';
import {
  DEFAULT_APPLICATION_SCOPES,
  parseConfiguredScope,
  splitScope,
} from '../oidc/scopes';

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
  allowedScopes: string[];
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
  allowedScopes: string[];
}

/** What the token surface needs to know about a client. */
export interface ClientRecord {
  id: string;
  clientId: string;
  organizationId: string;
  type: ApplicationType;
  enabled: boolean;
  allowedScopes: string[];
}

interface ApplicationRow {
  id: string;
  name: string;
  type: ApplicationType;
  client_id: string;
  disabled_at: string | null;
  deleted_at: string | null;
  created_at: string;
  allowed_scopes: string;
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
  async register(input: {
    organizationId: string;
    actor: string;
    name: string;
    type: ApplicationType;
  }): Promise<{ application: ApplicationView; clientSecret: string | null }> {
    const name = input.name.trim();
    if (name.length === 0) throw new BadRequestException('an Application name is required');
    const id = uuid();
    const clientId = randomToken(16);
    const now = new Date().toISOString();
    const allowedScopes = DEFAULT_APPLICATION_SCOPES;

    // Registration and the confidential client's first secret are one unit:
    // a Web Application must never exist without the credential that makes it
    // useful, and a failed issuance must not leave a half-registered row.
    const clientSecret = await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO applications (id, organization_id, name, type, client_id, created_by, created_at, allowed_scopes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.organizationId,
          name,
          input.type,
          clientId,
          input.actor,
          now,
          allowedScopes.join(' '),
        ],
      );

      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'application.registered',
        detail: {
          applicationId: id,
          name,
          type: input.type,
          clientId,
        },
      });

      if (input.type !== 'web') return null;
      const issued = await this.issueSecretWith(tx, {
        organizationId: input.organizationId,
        applicationId: id,
        actor: input.actor,
        label: 'default',
      });
      return issued.clientSecret;
    });

    return { application: await this.view(this.db, input.organizationId, id), clientSecret };
  }

  async list(organizationId: string): Promise<ApplicationView[]> {
    const rows = await this.db.all<ApplicationRow>(
      `SELECT id, name, type, client_id, disabled_at, deleted_at, created_at, allowed_scopes FROM applications
         WHERE organization_id = ? ORDER BY created_at`,
      [organizationId],
    );
    return Promise.all(rows.map((row) => this.toView(this.db, row)));
  }

  async find(organizationId: string, id: string): Promise<ApplicationView> {
    return this.view(this.db, organizationId, id);
  }

  /**
   * Pause an Application (ADR-0007): new authentication is refused and every
   * refresh token minted through its flows is revoked immediately, while the
   * platform Sessions survive — a pause is not credential revocation, so the
   * Client Secrets stay valid. Reversible via `enable`; idempotent.
   */
  async disable(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
  }): Promise<ApplicationView> {
    const application = await this.requireApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    if (application.deleted_at !== null) {
      return this.view(this.db, input.organizationId, application.id);
    }

    const now = new Date().toISOString();
    // State change, revocation, and audit are one unit: a paused Application
    // whose app-minted tokens outlive the pause is the lie disable exists to
    // prevent.
    await this.db.transaction(async (tx) => {
      const changed = await tx.run(
        'UPDATE applications SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL',
        [now, application.id],
      );
      if (changed.rowCount !== 1) return;

      const refreshTokensRevoked = await this.sessions.revokeRefreshTokensForApplication(
        tx,
        application.id,
      );
      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'application.disabled',
        detail: {
          applicationId: application.id,
          name: application.name,
          refreshTokensRevoked,
        },
      });
    });
    return this.view(this.db, input.organizationId, application.id);
  }

  /** Reverse the pause. Revoked refresh tokens stay dead (ADR-0007). */
  async enable(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
  }): Promise<ApplicationView> {
    const application = await this.requireApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    if (application.deleted_at !== null) {
      return this.view(this.db, input.organizationId, application.id);
    }

    const changed = await this.db.run(
      'UPDATE applications SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL AND deleted_at IS NULL',
      [application.id],
    );
    if (changed.rowCount === 1) {
      await recordAuditEvent(this.db, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'application.enabled',
        detail: {
          applicationId: application.id,
          name: application.name,
        },
      });
    }
    return this.view(this.db, input.organizationId, application.id);
  }

  /**
   * Delete an Application — irreversible (ADR-0007). Enrollments are removed,
   * Client Secrets and app-minted refresh tokens are revoked, and the
   * Application's name is destroyed and pseudonymized in both the row and its
   * surviving audit trail. Identities are never touched: the Organization owns
   * them, so even Identities left with no Enrollments survive. Idempotent.
   */
  async remove(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
  }): Promise<ApplicationView> {
    const application = await this.requireApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    if (application.deleted_at !== null) {
      return this.view(this.db, input.organizationId, application.id);
    }

    const now = new Date().toISOString();
    const pseudonym = deletedApplicationPseudonym(application.id);

    await this.db.transaction(async (tx) => {
      // The terminal marker is the race-free arbiter: a concurrent second
      // delete commits without duplicating the event or re-pseudonymizing.
      const marked = await tx.run(
        'UPDATE applications SET name = ?, disabled_at = COALESCE(disabled_at, ?), deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
        [pseudonym, now, now, application.id],
      );
      if (marked.rowCount !== 1) return;

      const secrets = await tx.run(
        `UPDATE client_secrets SET revoked_at = ?, revoked_by = ?
            WHERE application_id = ? AND revoked_at IS NULL`,
        [now, input.actor, application.id],
      );
      const refreshTokensRevoked = await this.sessions.revokeRefreshTokensForApplication(
        tx,
        application.id,
      );
      const enrollmentsRemoved = await this.enrollments.removeAllForApplication(
        tx,
        application.id,
      );
      // The durable key is the applicationId; the human-facing name in
      // historical details is PII, so the surviving trail is re-attributed to
      // the pseudonymous shell.
      await tx.run(
        `UPDATE audit_events
            SET detail = jsonb_set(detail::jsonb, '{name}', to_jsonb(?::text))::text
          WHERE organization_id = ?
            AND (detail::jsonb ->> 'applicationId') = ?
            AND (detail::jsonb ->> 'name') IS NOT NULL`,
        [pseudonym, input.organizationId, application.id],
      );
      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'application.deleted',
        detail: {
          applicationId: application.id,
          pseudonym,
          enrollmentsRemoved,
          secretsRevoked: secrets.rowCount,
          refreshTokensRevoked,
        },
      });
    });
    return this.view(this.db, input.organizationId, application.id);
  }

  /**
   * Resolve a Client ID at the authorization boundary, with the Organization
   * it belongs to and the exact-match redirect URI list. Returns undefined for
   * an unknown client; the caller decides how to refuse without leaking which
   * part was wrong.
   */
  async findForAuthorization(clientId: string): Promise<AuthorizeClient | undefined> {
    const row = await this.db.get<{
      id: string;
      client_id: string;
      organization_id: string;
      organization_name: string;
      name: string;
      type: ApplicationType;
      disabled_at: string | null;
      deleted_at: string | null;
      allowed_scopes: string;
    }>(
      `SELECT a.id, a.client_id, a.organization_id, a.name, a.type, a.disabled_at, a.deleted_at,
                a.allowed_scopes, o.name AS organization_name
         FROM applications a JOIN organizations o ON o.id = a.organization_id
         WHERE a.client_id = ?`,
      [clientId],
    );
    if (!row) return undefined;

    const redirectUris = await this.db.all<{ uri: string }>(
      'SELECT uri FROM redirect_uris WHERE application_id = ? ORDER BY created_at, id',
      [row.id],
    );
    return {
      id: row.id,
      clientId: row.client_id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      name: row.name,
      type: row.type,
      enabled: this.isUsable(row),
      redirectUris: redirectUris.map((entry) => entry.uri),
      allowedScopes: splitScope(row.allowed_scopes),
    };
  }

  /** Resolve a Client ID at the token boundary; no redirect URIs needed there. */
  async findClient(clientId: string): Promise<ClientRecord | undefined> {
    const row = await this.db.get<{
      id: string;
      client_id: string;
      organization_id: string;
      type: ApplicationType;
      disabled_at: string | null;
      deleted_at: string | null;
      allowed_scopes: string;
    }>(
      'SELECT id, client_id, organization_id, type, disabled_at, deleted_at, allowed_scopes FROM applications WHERE client_id = ?',
      [clientId],
    );
    if (!row) return undefined;
    return {
      id: row.id,
      clientId: row.client_id,
      organizationId: row.organization_id,
      type: row.type,
      enabled: this.isUsable(row),
      allowedScopes: splitScope(row.allowed_scopes),
    };
  }

  /**
   * Whether a presented Client Secret is one of the Application's currently
   * valid concurrent secrets (ADR-0010). Revocation applies immediately: a
   * revoked secret simply is not in the active set any more. Secrets are
   * high-entropy, so comparing their stored hashes is the verification.
   */
  async verifyClientSecret(applicationId: string, secret: string): Promise<boolean> {
    const presented = Buffer.from(hashToken(secret));
    const hashes = await this.db.all<{ secret_hash: string }>(
      'SELECT secret_hash FROM client_secrets WHERE application_id = ? AND revoked_at IS NULL',
      [applicationId],
    );
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
  async issueSecret(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
    label: string;
  }): Promise<{ secret: SecretView; clientSecret: string }> {
    return this.issueSecretWith(this.db, input);
  }

  /**
   * The issuance itself, on the caller's client so registration can mint the
   * first secret inside its own transaction.
   */
  private async issueSecretWith(
    db: DataHandle,
    input: {
      organizationId: string;
      applicationId: string;
      actor: string;
      label: string;
    },
  ): Promise<{ secret: SecretView; clientSecret: string }> {
    const application = await this.requireMutableApplication(
      db,
      input.organizationId,
      input.applicationId,
    );
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
    await db.run(
      `INSERT INTO client_secrets (id, application_id, label, secret_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [secretId, input.applicationId, label, hashToken(clientSecret), input.actor, now],
    );

    await recordAuditEvent(db, {
      organizationId: input.organizationId,
      actor: input.actor,
      kind: 'client_secret.generated',
      detail: {
        applicationId: input.applicationId,
        secretId,
        label,
      },
    });

    return { secret: { id: secretId, label, createdAt: now, revokedAt: null }, clientSecret };
  }

  /**
   * Revoke one secret by id, leaving every sibling untouched. Idempotent: a
   * second revoke of a dead secret is not an error, it simply changes nothing.
   */
  async revokeSecret(input: {
    organizationId: string;
    applicationId: string;
    secretId: string;
    actor: string;
  }): Promise<SecretView> {
    const application = await this.requireMutableApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    const row = await this.db.get<SecretRow>(
      'SELECT id, label, created_at, revoked_at FROM client_secrets WHERE id = ? AND application_id = ?',
      [input.secretId, application.id],
    );
    if (!row) throw new NotFoundException('no such Client Secret');

    if (row.revoked_at === null) {
      const now = new Date().toISOString();
      await this.db.run(
        `UPDATE client_secrets SET revoked_at = ?, revoked_by = ?
           WHERE id = ? AND revoked_at IS NULL`,
        [now, input.actor, input.secretId],
      );
      await recordAuditEvent(this.db, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'client_secret.revoked',
        detail: {
          applicationId: application.id,
          secretId: input.secretId,
          label: row.label,
        },
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
  async addRedirectUri(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
    uri: string;
  }): Promise<RedirectUriView> {
    const application = await this.requireMutableApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    const uri = validateRedirectUri(input.uri);
    await this.refuseDuplicateRedirectUri(this.db, application.id, uri);

    const id = uuid();
    const now = new Date().toISOString();
    // The change and its audit event are one unit: a persisted redirect URI
    // with no event beside it is the silent code-interception primitive
    // ADR-0010 exists to prevent.
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO redirect_uris (id, application_id, uri, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        [id, application.id, uri, input.actor, now],
      );
      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'redirect_uri.added',
        detail: {
          applicationId: application.id,
          uriId: id,
          uri,
        },
      });
    });
    return { id, uri, createdAt: now, updatedAt: null };
  }

  /**
   * Replace a redirect URI's value. Validation and the duplicate rule are the
   * same as for an addition; the prior value rides along in the audit event so
   * the exact change is answerable after the fact.
   */
  async updateRedirectUri(input: {
    organizationId: string;
    applicationId: string;
    uriId: string;
    actor: string;
    uri: string;
  }): Promise<RedirectUriView> {
    const application = await this.requireMutableApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    const row = await this.requireRedirectUri(this.db, application.id, input.uriId);
    const uri = validateRedirectUri(input.uri);
    if (uri === row.uri) return this.redirectUriView(row);

    await this.refuseDuplicateRedirectUri(this.db, application.id, uri, row.id);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.run('UPDATE redirect_uris SET uri = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
        uri,
        input.actor,
        now,
        row.id,
      ]);
      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'redirect_uri.updated',
        detail: {
          applicationId: application.id,
          uriId: row.id,
          previousUri: row.uri,
          uri,
        },
      });
    });
    return { id: row.id, uri, createdAt: row.created_at, updatedAt: now };
  }

  /** Remove a redirect URI. There is no prefix or wildcard echo to clean up. */
  async removeRedirectUri(input: {
    organizationId: string;
    applicationId: string;
    uriId: string;
    actor: string;
  }): Promise<RedirectUriView> {
    const application = await this.requireMutableApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    const row = await this.requireRedirectUri(this.db, application.id, input.uriId);
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM redirect_uris WHERE id = ? AND application_id = ?', [
        row.id,
        application.id,
      ]);
      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'redirect_uri.removed',
        detail: {
          applicationId: application.id,
          uriId: row.id,
          uri: row.uri,
        },
      });
    });
    return this.redirectUriView(row);
  }

  /**
   * Configure the scope set this Application may request (ADR-0016). Scopes
   * govern token contents, so the change is audit-logged with both the prior
   * and the new set; `openid` is always included because every supported flow
   * is OIDC. A no-op when the value is already in force. Members may pull this
   * lever: narrowing integration configuration is not a destructive or
   * credential-issuing action.
   */
  async setScopes(input: {
    organizationId: string;
    applicationId: string;
    actor: string;
    scopes: unknown;
  }): Promise<ApplicationView> {
    const application = await this.requireMutableApplication(
      this.db,
      input.organizationId,
      input.applicationId,
    );
    const scopes = parseConfiguredScope(input.scopes);
    if (!scopes) {
      throw new BadRequestException(
        'scopes must be a non-empty list of openid, email, and profile, including openid',
      );
    }
    const previous = splitScope(application.allowed_scopes);
    if (previous.join(' ') === scopes.join(' ')) return this.toView(this.db, application);

    await this.db.transaction(async (tx) => {
      await tx.run('UPDATE applications SET allowed_scopes = ? WHERE id = ?', [
        scopes.join(' '),
        application.id,
      ]);
      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'application.scopes.updated',
        detail: {
          applicationId: application.id,
          previousScopes: previous,
          scopes,
        },
      });
    });
    return this.view(this.db, input.organizationId, application.id);
  }

  private async requireRedirectUri(
    db: DataAccess,
    applicationId: string,
    uriId: string,
  ): Promise<RedirectUriRow> {
    const row = await db.get<RedirectUriRow>(
      'SELECT id, uri, created_at, updated_at FROM redirect_uris WHERE id = ? AND application_id = ?',
      [uriId, applicationId],
    );
    if (!row) throw new NotFoundException('no such redirect URI');
    return row;
  }

  private async refuseDuplicateRedirectUri(
    db: DataAccess,
    applicationId: string,
    uri: string,
    exceptId?: string,
  ): Promise<void> {
    const duplicate = exceptId
      ? await db.get(
          'SELECT id FROM redirect_uris WHERE application_id = ? AND uri = ? AND id <> ?',
          [applicationId, uri, exceptId],
        )
      : await db.get('SELECT id FROM redirect_uris WHERE application_id = ? AND uri = ?', [
          applicationId,
          uri,
        ]);
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

  private async requireApplication(
    db: DataAccess,
    organizationId: string,
    id: string,
  ): Promise<ApplicationRow> {
    const row = await db.get<ApplicationRow>(
      'SELECT id, name, type, client_id, disabled_at, deleted_at, created_at, allowed_scopes FROM applications WHERE id = ? AND organization_id = ?',
      [id, organizationId],
    );
    if (!row) throw new NotFoundException('no such Application');
    return row;
  }

  /**
   * A Deleted Application is a terminal pseudonymous shell: it stays readable,
   * but nothing about it is configurable any more. Every credential and
   * redirect mutation goes through here so "credentials revoked immediately"
   * cannot be undone by minting a replacement after deletion (ADR-0007).
   */
  private async requireMutableApplication(
    db: DataAccess,
    organizationId: string,
    id: string,
  ): Promise<ApplicationRow> {
    const application = await this.requireApplication(db, organizationId, id);
    if (application.deleted_at !== null) {
      throw new ConflictException('the Application has been deleted and cannot be changed');
    }
    return application;
  }

  private async view(db: DataAccess, organizationId: string, id: string): Promise<ApplicationView> {
    return this.toView(db, await this.requireApplication(db, organizationId, id));
  }

  private async toView(db: DataAccess, row: ApplicationRow): Promise<ApplicationView> {
    const secrets = await db.all<SecretRow>(
      'SELECT id, label, created_at, revoked_at FROM client_secrets WHERE application_id = ? ORDER BY created_at, id',
      [row.id],
    );
    const redirectUris = await db.all<RedirectUriRow>(
      'SELECT id, uri, created_at, updated_at FROM redirect_uris WHERE application_id = ? ORDER BY created_at, id',
      [row.id],
    );
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
      allowedScopes: splitScope(row.allowed_scopes),
      secrets: secrets.map((secret) => ({
        id: secret.id,
        label: secret.label,
        createdAt: secret.created_at,
        revokedAt: secret.revoked_at,
      })),
      redirectUris: redirectUris.map((entry) => this.redirectUriView(entry)),
    };
  }
}
