import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { hashToken, randomToken } from '../crypto/password';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

export type ApplicationType = 'web' | 'spa';

export interface SecretView {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApplicationView {
  id: string;
  name: string;
  type: ApplicationType;
  clientId: string;
  createdAt: string;
  secrets: SecretView[];
}

interface ApplicationRow {
  id: string;
  name: string;
  type: ApplicationType;
  client_id: string;
  created_at: string;
}

interface SecretRow {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
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
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
        `SELECT id, name, type, client_id, created_at FROM applications
         WHERE organization_id = ? ORDER BY created_at`,
      )
      .all(organizationId) as unknown as ApplicationRow[];
    return rows.map((row) => this.toView(row));
  }

  find(organizationId: string, id: string): ApplicationView {
    return this.view(organizationId, id);
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

  private requireApplication(organizationId: string, id: string): ApplicationRow {
    const row = this.db
      .prepare(
        'SELECT id, name, type, client_id, created_at FROM applications WHERE id = ? AND organization_id = ?',
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
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      clientId: row.client_id,
      createdAt: row.created_at,
      secrets: secrets.map((secret) => ({
        id: secret.id,
        label: secret.label,
        createdAt: secret.created_at,
        revokedAt: secret.revoked_at,
      })),
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
