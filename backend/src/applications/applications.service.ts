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
import type { Application, Prisma, RedirectUri } from '../generated/prisma/client';
import { recordAuditEvent } from '../storage/audit';
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

import type { ApplicationType } from '../generated/prisma/client';

export type { ApplicationType };

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
    const now = new Date();
    const allowedScopes = DEFAULT_APPLICATION_SCOPES;

    // Registration and the confidential client's first secret are one unit:
    // a Web Application must never exist without the credential that makes it
    // useful, and a failed issuance must not leave a half-registered row.
    const clientSecret = await this.db.$transaction(async (tx) => {
      await tx.application.create({
        data: {
          id,
          organizationId: input.organizationId,
          name,
          type: input.type,
          clientId,
          createdBy: input.actor,
          createdAt: now,
          allowedScopes: allowedScopes.join(' '),
        },
      });

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
    const rows = await this.db.application.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
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
    if (application.deletedAt !== null) {
      return this.view(this.db, input.organizationId, application.id);
    }

    const now = new Date();
    // State change, revocation, and audit are one unit: a paused Application
    // whose app-minted tokens outlive the pause is the lie disable exists to
    // prevent.
    await this.db.$transaction(async (tx) => {
      const changed = await tx.application.updateMany({
        where: { id: application.id, disabledAt: null, deletedAt: null },
        data: { disabledAt: now },
      });
      if (changed.count !== 1) return;

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
    if (application.deletedAt !== null) {
      return this.view(this.db, input.organizationId, application.id);
    }

    const changed = await this.db.application.updateMany({
      where: { id: application.id, disabledAt: { not: null }, deletedAt: null },
      data: { disabledAt: null },
    });
    if (changed.count === 1) {
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
    if (application.deletedAt !== null) {
      return this.view(this.db, input.organizationId, application.id);
    }

    const now = new Date();
    const pseudonym = deletedApplicationPseudonym(application.id);

    await this.db.$transaction(async (tx) => {
      // The terminal marker is the race-free arbiter: a concurrent second
      // delete commits without duplicating the event or re-pseudonymizing.
      // Prisma cannot express COALESCE in an update, so an Application that
      // was already disabled keeps the timestamp read above; only deleting a
      // still-active Application needs the delete instant.
      const marked = await tx.application.updateMany({
        where: { id: application.id, deletedAt: null },
        data: {
          name: pseudonym,
          disabledAt: application.disabledAt ?? now,
          deletedAt: now,
        },
      });
      if (marked.count !== 1) return;

      const secrets = await tx.clientSecret.updateMany({
        where: { applicationId: application.id, revokedAt: null },
        data: { revokedAt: now, revokedBy: input.actor },
      });
      const refreshTokensRevoked = await this.sessions.revokeRefreshTokensForApplication(
        tx,
        application.id,
      );
      const enrollmentsRemoved = await this.enrollments.removeAllForApplication(
        tx,
        application.id,
      );
      // Deliberate raw-SQL exception (ADR-0027): the surviving trail's detail
      // is a JSONB column, and rewriting one field in place — only where that
      // field exists — is jsonb_set's job; no typed update expresses it.
      // Parameterized, never interpolated. The durable key is the
      // applicationId; the human-facing name in historical details is PII, so
      // the trail is re-attributed to the pseudonymous shell.
      await tx.$executeRaw`
        UPDATE audit_events
            SET detail = jsonb_set(detail, '{name}', to_jsonb(${pseudonym}::text))
          WHERE organization_id = ${input.organizationId}
            AND (detail ->> 'applicationId') = ${application.id}
            AND (detail ->> 'name') IS NOT NULL`;
      await recordAuditEvent(tx, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'application.deleted',
        detail: {
          applicationId: application.id,
          pseudonym,
          enrollmentsRemoved,
          secretsRevoked: secrets.count,
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
    const row = await this.db.application.findUnique({
      where: { clientId },
      include: {
        organization: { select: { name: true } },
        redirectUris: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { uri: true },
        },
      },
    });
    if (!row) return undefined;

    return {
      id: row.id,
      clientId: row.clientId,
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      name: row.name,
      type: row.type,
      enabled: this.isUsable(row),
      redirectUris: row.redirectUris.map((entry) => entry.uri),
      allowedScopes: splitScope(row.allowedScopes),
    };
  }

  /** Resolve a Client ID at the token boundary; no redirect URIs needed there. */
  async findClient(clientId: string): Promise<ClientRecord | undefined> {
    const row = await this.db.application.findUnique({
      where: { clientId },
      select: {
        id: true,
        clientId: true,
        organizationId: true,
        type: true,
        disabledAt: true,
        deletedAt: true,
        allowedScopes: true,
      },
    });
    if (!row) return undefined;
    return {
      id: row.id,
      clientId: row.clientId,
      organizationId: row.organizationId,
      type: row.type,
      enabled: this.isUsable(row),
      allowedScopes: splitScope(row.allowedScopes),
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
    const hashes = await this.db.clientSecret.findMany({
      where: { applicationId, revokedAt: null },
      select: { secretHash: true },
    });
    for (const row of hashes) {
      const stored = Buffer.from(row.secretHash);
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
    db: Prisma.TransactionClient,
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
    const now = new Date();
    await db.clientSecret.create({
      data: {
        id: secretId,
        applicationId: input.applicationId,
        label,
        secretHash: hashToken(clientSecret),
        createdBy: input.actor,
        createdAt: now,
      },
    });

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

    return {
      secret: { id: secretId, label, createdAt: now.toISOString(), revokedAt: null },
      clientSecret,
    };
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
    const row = await this.db.clientSecret.findFirst({
      where: { id: input.secretId, applicationId: application.id },
    });
    if (!row) throw new NotFoundException('no such Client Secret');

    if (row.revokedAt === null) {
      const now = new Date();
      await this.db.clientSecret.updateMany({
        where: { id: input.secretId, revokedAt: null },
        data: { revokedAt: now, revokedBy: input.actor },
      });
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
      row.revokedAt = now;
    }

    return {
      id: row.id,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
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
    const now = new Date();
    // The change and its audit event are one unit: a persisted redirect URI
    // with no event beside it is the silent code-interception primitive
    // ADR-0010 exists to prevent.
    await this.db.$transaction(async (tx) => {
      await tx.redirectUri.create({
        data: {
          id,
          applicationId: application.id,
          uri,
          createdBy: input.actor,
          createdAt: now,
        },
      });
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
    return { id, uri, createdAt: now.toISOString(), updatedAt: null };
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
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      // updateMany, not update: a concurrently removed row must keep the old
      // statement's silent no-op instead of failing the transaction.
      await tx.redirectUri.updateMany({
        where: { id: row.id },
        data: { uri, updatedBy: input.actor, updatedAt: now },
      });
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
    return { id: row.id, uri, createdAt: row.createdAt.toISOString(), updatedAt: now.toISOString() };
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
    await this.db.$transaction(async (tx) => {
      await tx.redirectUri.deleteMany({
        where: { id: row.id, applicationId: application.id },
      });
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
    const previous = splitScope(application.allowedScopes);
    if (previous.join(' ') === scopes.join(' ')) return this.toView(this.db, application);

    await this.db.$transaction(async (tx) => {
      await tx.application.update({
        where: { id: application.id },
        data: { allowedScopes: scopes.join(' ') },
      });
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
    db: Prisma.TransactionClient,
    applicationId: string,
    uriId: string,
  ): Promise<RedirectUri> {
    const row = await db.redirectUri.findFirst({
      where: { id: uriId, applicationId },
    });
    if (!row) throw new NotFoundException('no such redirect URI');
    return row;
  }

  private async refuseDuplicateRedirectUri(
    db: Prisma.TransactionClient,
    applicationId: string,
    uri: string,
    exceptId?: string,
  ): Promise<void> {
    const duplicate = await db.redirectUri.findFirst({
      where: exceptId
        ? { applicationId, uri, id: { not: exceptId } }
        : { applicationId, uri },
      select: { id: true },
    });
    if (duplicate) throw new ConflictException('this redirect URI is already registered');
  }

  private redirectUriView(row: RedirectUri): RedirectUriView {
    return {
      id: row.id,
      uri: row.uri,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }

  /** Whether the Application may mint new authentication and tokens at all. */
  private isUsable(row: Pick<Application, 'disabledAt' | 'deletedAt'>): boolean {
    return row.disabledAt === null && row.deletedAt === null;
  }

  private async requireApplication(
    db: Prisma.TransactionClient,
    organizationId: string,
    id: string,
  ): Promise<Application> {
    const row = await db.application.findFirst({
      where: { id, organizationId },
    });
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
    db: Prisma.TransactionClient,
    organizationId: string,
    id: string,
  ): Promise<Application> {
    const application = await this.requireApplication(db, organizationId, id);
    if (application.deletedAt !== null) {
      throw new ConflictException('the Application has been deleted and cannot be changed');
    }
    return application;
  }

  private async view(db: Prisma.TransactionClient, organizationId: string, id: string): Promise<ApplicationView> {
    return this.toView(db, await this.requireApplication(db, organizationId, id));
  }

  private async toView(db: Prisma.TransactionClient, row: Application): Promise<ApplicationView> {
    const secrets = await db.clientSecret.findMany({
      where: { applicationId: row.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const redirectUris = await db.redirectUri.findMany({
      where: { applicationId: row.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      clientId: row.clientId,
      state: applicationState({
        disabled: row.disabledAt !== null,
        deleted: row.deletedAt !== null,
      }),
      createdAt: row.createdAt.toISOString(),
      allowedScopes: splitScope(row.allowedScopes),
      secrets: secrets.map((secret) => ({
        id: secret.id,
        label: secret.label,
        createdAt: secret.createdAt.toISOString(),
        revokedAt: secret.revokedAt?.toISOString() ?? null,
      })),
      redirectUris: redirectUris.map((entry) => this.redirectUriView(entry)),
    };
  }
}
