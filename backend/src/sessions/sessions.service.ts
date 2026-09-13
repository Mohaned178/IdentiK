import { Inject, Injectable } from '@nestjs/common';
import { hashToken, randomToken } from '../crypto/password';
import { parseTtlMs } from '../config/env';
import { identityGate } from '../identities/identity-state';
import { OrganizationSettingsService } from '../settings/organization-settings.service';
import { recordAuditEvent } from '../storage/audit';
import type { DataAccess } from '../storage/data-access';
import { DATABASE, Database } from '../storage/token';
import { uuid } from '../bootstrap/uuid';

export interface SsoSession {
  id: string;
  identityId: string;
  organizationId: string;
  email: string;
}

export interface LiveSession extends SsoSession {
  createdAt: string;
  expiresAt: string;
}

/** A recognizable device row for the Account Center's Session list. */
export interface SessionSummary {
  id: string;
  device: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** Why a Session was revoked, carried in the audit detail. */
export type SessionRevocationReason =
  | 'account_center'
  | 'sign_out'
  | 'suspension'
  | 'administrator'
  | 'password_change'
  | 'password_reset'
  | 'anonymization';

interface SessionRow {
  id: string;
  identity_id: string;
  organization_id: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  email: string;
  email_verified: number;
  suspended_at: string | null;
  anonymized_at: string | null;
  sessions_revoked_at: string | null;
}

/** The columns a revoke-many unit needs to kill a Session and its lineage. */
interface SessionRef {
  id: string;
  identity_id: string;
  organization_id: string;
}

/** The inputs every revoke-many cascade carries. */
interface RevokeManyInput {
  identityId: string;
  organizationId: string;
  reason: SessionRevocationReason;
  actor: string;
}

const SESSION_ROW_COLUMNS = `s.id, s.identity_id, s.organization_id, s.user_agent, s.created_at,
        s.last_seen_at, s.expires_at, s.revoked_at, i.email, i.email_verified, i.suspended_at,
        i.anonymized_at, i.sessions_revoked_at`;

/**
 * A Session is the durable record of one authentication of one Identity — the
 * signed-in device (ADR-0013). It parents the SSO cookie and, from ticket 10,
 * every refresh token minted through any Application's flow. The SSO token is
 * stored verifiable-only; resolution fails closed on revocation, expiry, the
 * Identity's `sessions_revoked_at` watermark (a password reset revokes every
 * Session created at or before it), an unverified Identity, and suspension.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly settings: OrganizationSettingsService,
  ) {}

  /**
   * The browser cookie's absolute cap. Which Session is still live is decided
   * by the Organization's idle window (ADR-0022), enforced in `isLive`; the
   * cookie simply never needs to outlive the cap. Per-Organization timeout is
   * the policy half; this deployment value is the transport envelope.
   */
  ttlMs(): number {
    return parseTtlMs('IDENTIK_SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000);
  }

  create(input: {
    identityId: string;
    organizationId: string;
    userAgent: string | null;
  }): { token: string; sessionId: string } {
    const token = randomToken(32);
    const id = uuid();
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, identity_id, organization_id, sso_token_hash, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.identityId,
        input.organizationId,
        hashToken(token),
        input.userAgent,
        now.toISOString(),
        now.toISOString(),
        new Date(now.getTime() + this.settings.idleTimeoutMs(input.organizationId)).toISOString(),
      );
    return { token, sessionId: id };
  }

  /** Resolve a live SSO token, or null when the device is no longer signed in. */
  resolve(token: string): SsoSession | null {
    const row = this.findRow('s.sso_token_hash = ?', hashToken(token));
    if (!row) return null;
    const session = this.toSession(row);
    // Only live Sessions record activity: a dead cookie must not refresh the
    // last-seen time of a device the End User already revoked.
    if (!session) return null;
    this.touch(row);
    return session;
  }

  /**
   * Resolve a Session by id with the same fail-closed checks. Refresh tokens
   * are children of the Session (ADR-0013), so refresh validation asks this:
   * a dead parent cannot mint new tokens, whatever route killed it — the
   * Account Center, a suspension, a password reset.
   *
   * `touch` distinguishes real activity from a liveness check. A token grant
   * is activity and refreshes the idle window (ADR-0022); pure validation such
   * as introspection must not, or a server-to-server poll would keep an
   * otherwise idle Session alive.
   */
  resolveById(sessionId: string, options: { touch?: boolean } = {}): LiveSession | null {
    const row = this.findRow('s.id = ?', sessionId);
    if (!row) return null;
    const session = this.toSession(row);
    if (!session) return null;
    const expiresAt = options.touch === true ? this.touch(row) : row.expires_at;
    return { ...session, createdAt: row.created_at, expiresAt };
  }

  /**
   * The Identity's active Sessions for the Account Center: the same
   * fail-closed liveness gate as resolution, newest activity first, each with
   * the device metadata a non-expert can recognize (user agent, sign-in time,
   * last-seen time).
   */
  listForIdentity(identityId: string): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions s JOIN identities i ON i.id = s.identity_id
         WHERE s.identity_id = ?
         ORDER BY s.last_seen_at DESC, s.created_at DESC`,
      )
      .all(identityId) as unknown as SessionRow[];
    return rows.filter((row) => this.isLive(row)).map((row) => this.toSummary(row));
  }

  /**
   * Sign-out is revocation of the current Session (ADR-0013). Uniform and
   * idempotent: an absent, stale, or dead cookie revokes nothing.
   */
  signOut(token: string): void {
    const session = this.resolve(token);
    if (!session) return;
    this.revoke({ sessionId: session.id, identityId: session.identityId, reason: 'sign_out' });
  }

  /**
   * Revoke one Session of one Identity (ADR-0013). The session row is the
   * arbiter: only a Session belonging to the requesting Identity can be
   * revoked, so a foreign id is simply "not found". The revocation, the
   * descendant refresh-token cascade, and the audit event are one unit —
   * a revoked Session whose tokens outlive it would be exactly the lie the
   * revocable anchor exists to prevent. Idempotent: revoking a dead Session
   * changes nothing and is not an error.
   */
  revoke(input: {
    sessionId: string;
    identityId: string;
    reason: SessionRevocationReason;
  }): boolean {
    const row = this.db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions s JOIN identities i ON i.id = s.identity_id
         WHERE s.id = ? AND s.identity_id = ?`,
      )
      .get(input.sessionId, input.identityId) as SessionRow | undefined;
    if (!row) return false;
    if (row.revoked_at !== null) return true;

    this.db.exec('BEGIN');
    try {
      this.revokeRow(row, input.reason, 'end-user');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  /**
   * Revoke every Session of one Identity in one unit (ADR-0006): the devices
   * die, their descendant refresh tokens die, each death is a `session.revoked`
   * event, and one `identity.sessions.revoked` event records the collection
   * action itself — so a revoke-all with zero live devices is still visible.
   * Identity suspension and Enrollment suspension both walk this path: the
   * platform Session is Organization-scoped, so any suspension that loses an
   * Identity at platform scope kills it wherever it was created.
   */
  revokeAllForIdentity(input: RevokeManyInput): number {
    const rows = this.db
      .prepare(
        `SELECT id, identity_id, organization_id FROM sessions
         WHERE identity_id = ? AND organization_id = ? AND revoked_at IS NULL`,
      )
      .all(input.identityId, input.organizationId) as unknown as SessionRef[];
    return this.revokeRows(rows, input);
  }

  /**
   * Revoke every Session of one Identity *except* the one where the change
   * happened (ADR-0013): the password-change cascade. The kept Session's SSO
   * cookie and its descendant refresh tokens survive; every other device dies
   * with its lineage in the same unit. The kept id is looked up inside the
   * Identity's own rows, so a foreign id kept nothing extra alive.
   */
  revokeOthersForIdentity(input: RevokeManyInput & { keepSessionId: string }): number {
    const rows = this.db
      .prepare(
        `SELECT id, identity_id, organization_id FROM sessions
         WHERE identity_id = ? AND organization_id = ? AND revoked_at IS NULL AND id != ?`,
      )
      .all(input.identityId, input.organizationId, input.keepSessionId) as unknown as SessionRef[];
    return this.revokeRows(rows, input);
  }

  /**
   * Revoke every refresh token minted through one Application's flows
   * (ADR-0007), leaving every Session — and every other Application's tokens —
   * alive. Used by the Application Disabled pause and by irreversible
   * Application deletion. Takes the caller's client so it can compose into
   * their transaction; idempotent by the `revoked_at IS NULL` guard.
   */
  async revokeRefreshTokensForApplication(db: DataAccess, applicationId: string): Promise<number> {
    const changed = await db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE application_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), applicationId],
    );
    return changed.rowCount;
  }

  /** One revoke-many unit: every row dies, one collection audit event lives. */
  private revokeRows(rows: SessionRef[], input: RevokeManyInput): number {
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        this.revokeRow(row, input.reason, input.actor);
      }
      recordAuditEvent(this.db, {
        organizationId: input.organizationId,
        actor: input.actor,
        kind: 'identity.sessions.revoked',
        detail: { identityId: input.identityId, count: rows.length, reason: input.reason },
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  /**
   * One Session's death is one unit (ADR-0013): the row, its descendant
   * refresh tokens, and its audit event — never a revoked Session whose
   * tokens outlive it. Callers own the transaction.
   */
  private revokeRow(
    row: SessionRef,
    reason: SessionRevocationReason,
    actor: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, row.id);
    this.db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL')
      .run(now, row.id);
    recordAuditEvent(this.db, {
      organizationId: row.organization_id,
      actor,
      kind: 'session.revoked',
      detail: { identityId: row.identity_id, sessionId: row.id, reason },
    });
  }

  private toSummary(row: SessionRow): SessionSummary {
    return {
      id: row.id,
      device: row.user_agent,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  private findRow(where: string, value: string): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions s JOIN identities i ON i.id = s.identity_id
         WHERE ${where}`,
      )
      .get(value) as SessionRow | undefined;
  }

  /**
   * Record activity: refresh the last-seen stamp and push the idle deadline
   * out by the Organization's window (ADR-0022). This is the whole "activity
   * refreshes the window" rule — no scheduler exists, so idleness is judged
   * lazily at the next resolution.
   */
  private touch(row: { id: string; organization_id: string }): string {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.settings.idleTimeoutMs(row.organization_id),
    ).toISOString();
    this.db
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(now.toISOString(), expiresAt, row.id);
    return expiresAt;
  }

  /** The gate every Session resolution passes: dead means dead. */
  private toSession(row: SessionRow): SsoSession | null {
    if (!this.isLive(row)) return null;
    return {
      id: row.id,
      identityId: row.identity_id,
      organizationId: row.organization_id,
      email: row.email,
    };
  }

  private isLive(row: SessionRow): boolean {
    const now = new Date().toISOString();
    if (row.revoked_at !== null) return false;
    // `expires_at` is the idle deadline the Organization's window sets and
    // every activity refreshes (ADR-0022), so an untouched Session lapses.
    if (row.expires_at <= now) return false;
    // The Identity's own gate is shared with the credential and token paths,
    // so suspension, anonymization, and an unverified handle cannot be
    // half-enforced here (ADR-0006/0007/0011).
    if (identityGate(row) !== 'live') return false;
    if (row.sessions_revoked_at !== null && row.created_at <= row.sessions_revoked_at) return false;
    return true;
  }
}
