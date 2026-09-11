import { Inject, Injectable } from '@nestjs/common';
import { hashToken, randomToken } from '../crypto/password';
import { parseTtlMs } from '../config/env';
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

interface SessionRow {
  id: string;
  identity_id: string;
  organization_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  email: string;
  email_verified: number;
  suspended_at: string | null;
  sessions_revoked_at: string | null;
}

const SESSION_ROW_COLUMNS = `s.id, s.identity_id, s.organization_id, s.created_at, s.expires_at,
        s.revoked_at, i.email, i.email_verified, i.suspended_at, i.sessions_revoked_at`;

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
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Instance-wide default for now; per-Organization session timeout is
   * Organization-scoped policy (ADR-0022) and arrives with the settings
   * surface in ticket 18.
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
        new Date(now.getTime() + this.ttlMs()).toISOString(),
      );
    return { token, sessionId: id };
  }

  /** Resolve a live SSO token, or null when the device is no longer signed in. */
  resolve(token: string): SsoSession | null {
    const row = this.findRow('s.sso_token_hash = ?', hashToken(token));
    if (!row) return null;
    this.db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);
    return this.toSession(row);
  }

  /**
   * Resolve a Session by id with the same fail-closed checks. Refresh tokens
   * are children of the Session (ADR-0013), so refresh validation asks this:
   * a dead parent cannot mint new tokens, whatever route killed it — the
   * Account Center, a suspension, a password reset.
   */
  resolveById(sessionId: string): LiveSession | null {
    const row = this.findRow('s.id = ?', sessionId);
    if (!row) return null;
    const session = this.toSession(row);
    if (!session) return null;
    return { ...session, createdAt: row.created_at, expiresAt: row.expires_at };
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
    if (row.expires_at <= now) return false;
    if (row.email_verified === 0) return false;
    if (row.suspended_at !== null) return false;
    if (row.sessions_revoked_at !== null && row.created_at <= row.sessions_revoked_at) return false;
    return true;
  }
}
