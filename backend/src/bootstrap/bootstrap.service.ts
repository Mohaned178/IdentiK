import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import {
  hashPassword,
  hashToken,
  randomToken,
} from '../crypto/password';
import { normalizeEmail } from '../identities/email';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';
import { uuid } from './uuid';

export interface BootstrapState {
  completed: boolean;
  available: boolean;
}

export enum CeremonyRefusedReason {
  AlreadyCompleted = 'already-completed',
  NotAvailable = 'not-available',
}

export type CeremonyResult =
  | {
      ok: true;
      value: { administratorId: string; organizationId: string; organizationName: string };
    }
  | { ok: false; reason: CeremonyRefusedReason };

interface ArmedCeremony {
  token_hash: string;
  expires_at: string;
}

/**
 * The Bootstrap Ceremony (ADR-0021): first boot of a fresh Instance creates
 * the default Organization and its first Owner through a one-time, expiring,
 * console-revealed token. Nobody invites the first Administrator — the
 * Instance does. Once completed it can never run again.
 *
 * The armed ceremony is durable: an untouched Instance that restarts does
 * NOT mint a fresh token — the original window keeps running down, so an
 * abandoned installation becomes permanently unclaimable once its window
 * lapses. Only the token itself lives in memory (shown once on console).
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private tokenHash: string | null = null;
  private expiresAt: number | null = null;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    const completed = await this.completed();
    if (completed) return;

    const armed = await this.readArmed();
    if (armed) {
      // Restart before completion: the window keeps running down. The token
      // cannot be re-revealed (it was shown once); the Instance must be
      // reinstalled to restart the ceremony.
      this.tokenHash = armed.token_hash;
      this.expiresAt = new Date(armed.expires_at).getTime();
      return;
    }

    const token = randomToken(32);
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + this.tokenTtlMs();
    await this.db.run(
      "INSERT OR REPLACE INTO instance_state (key, value) VALUES ('bootstrap_armed', ?)",
      [
        JSON.stringify({
          token_hash: tokenHash,
          expires_at: new Date(expiresAt).toISOString(),
        } satisfies ArmedCeremony),
      ],
    );
    this.tokenHash = tokenHash;
    this.expiresAt = expiresAt;
    console.log(
      `\nIdentiK first boot — setup token: ${token}\n` +
        `Shown once, expires in ${this.tokenTtlLabel()}.\n` +
        `Complete the Bootstrap Ceremony at /setup on this Instance.\n`,
    );
  }

  async state(): Promise<BootstrapState> {
    const completed = await this.completed();
    return { completed, available: !completed && this.tokenAlive() };
  }

  async complete(
    token: string,
    input: { organizationName: string; email: string; password: string; name: string },
  ): Promise<CeremonyResult> {
    const state = await this.state();
    if (state.completed) {
      return { ok: false, reason: CeremonyRefusedReason.AlreadyCompleted };
    }
    if (!state.available || !this.tokenMatches(token)) {
      return { ok: false, reason: CeremonyRefusedReason.NotAvailable };
    }

    const organizationId = uuid();
    const administratorId = uuid();
    const membershipId = uuid();
    const passwordHash = await hashPassword(input.password);
    const now = new Date().toISOString();
    // The Owner's email is a normalized handle, like every other Administrator
    // write path and the sign-in lookup (ADR-0021).
    const email = normalizeEmail(input.email);

    // The claim itself is the race-free arbiter: whichever request inserts
    // this row first completes the ceremony; every later request loses.
    const claimed = await this.db.transaction(async (tx) => {
      const { rowCount } = await tx.run(
        "INSERT OR IGNORE INTO instance_state (key, value) VALUES ('bootstrap', 'completed')",
      );
      if (rowCount !== 1) return false;

      await tx.run('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)', [
        organizationId,
        input.organizationName,
        now,
      ]);
      await tx.run(
        'INSERT INTO administrators (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        [administratorId, email, input.name, passwordHash, now],
      );
      await tx.run(
        'INSERT INTO memberships (id, organization_id, administrator_id, role) VALUES (?, ?, ?, ?)',
        [membershipId, organizationId, administratorId, 'owner'],
      );
      await recordAuditEvent(tx, {
        organizationId,
        actor: 'instance',
        kind: 'bootstrap.completed',
        detail: {
          organizationName: input.organizationName,
          ownerAdministratorId: administratorId,
        },
        occurredAt: now,
      });
      return true;
    });
    if (!claimed) {
      return { ok: false, reason: CeremonyRefusedReason.AlreadyCompleted };
    }

    this.tokenHash = null;
    this.expiresAt = null;
    return {
      ok: true,
      value: {
        administratorId,
        organizationId,
        organizationName: input.organizationName,
      },
    };
  }

  private async completed(): Promise<boolean> {
    const row = await this.db.get<{ value: string }>(
      "SELECT value FROM instance_state WHERE key = 'bootstrap'",
    );
    return row?.value === 'completed';
  }

  private async readArmed(): Promise<ArmedCeremony | null> {
    const row = await this.db.get<{ value: string }>(
      "SELECT value FROM instance_state WHERE key = 'bootstrap_armed'",
    );
    if (!row) return null;
    try {
      return JSON.parse(row.value) as ArmedCeremony;
    } catch {
      return null;
    }
  }

  private tokenAlive(): boolean {
    return this.tokenHash !== null && this.expiresAt !== null && Date.now() < this.expiresAt;
  }

  private tokenMatches(token: string): boolean {
    if (this.tokenHash === null) return false;
    const candidate = Buffer.from(hashToken(token));
    const expected = Buffer.from(this.tokenHash);
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  }

  private tokenTtlMs(): number {
    const raw = Number(process.env.IDENTIK_SETUP_TOKEN_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
  }

  private tokenTtlLabel(): string {
    const ms = this.tokenTtlMs();
    if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
    if (ms >= 60_000) return `${Math.round(ms / 60_000)}min`;
    return `${Math.round(ms / 1_000)}s`;
  }
}
