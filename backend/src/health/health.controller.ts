import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { MailHealth } from '../mail/mail-transport';
import { MailService } from '../mail/mail.service';
import { ShutdownService } from '../lifecycle/shutdown.service';
import { DATABASE, type Database } from '../storage/token';

/** How long the readiness database probe may take before it counts as down. */
const DATABASE_PROBE_TIMEOUT_MS = 2_000;

export interface LivenessView {
  status: 'ok';
}

export interface ReadinessView {
  status: 'ok' | 'degraded' | 'unavailable';
  /** Present whenever the dependencies were probed; absent while draining. */
  checks?: {
    database: { ok: boolean };
    mail: MailHealth;
  };
}

/**
 * The Instance's operational surface. Liveness reports the process alone so an
 * orchestrator never restarts it for a slow dependency; readiness reports the
 * dependencies — the database gates readiness (503 when unreachable), the mail
 * relay only degrades it: the SMTP-binding contract keeps an unreachable relay
 * diagnostic, never fatal. A draining Instance reports unavailable at once —
 * no probes — so a restart stops receiving new work. Both bodies are
 * deliberately coarse: booleans and the binding name, never a host, an error
 * string, or a timestamp.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly mail: MailService,
    @Inject(DATABASE) private readonly db: Database,
    private readonly shutdown: ShutdownService,
  ) {}

  @Get('live')
  liveness(): LivenessView {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessView> {
    // Draining: the verdict is immediate — no probe may delay the 503.
    if (this.shutdown.isDraining()) {
      res.status(503);
      return { status: 'unavailable' };
    }
    const [database, mail] = await Promise.all([this.databaseProbe(), this.mail.health()]);
    const status = !database.ok ? 'unavailable' : mail.reachable ? 'ok' : 'degraded';
    if (status === 'unavailable') res.status(503);
    return { status, checks: { database, mail } };
  }

  /** The original health path stays as the readiness alias. */
  @Get()
  alias(@Res({ passthrough: true }) res: Response): Promise<ReadinessView> {
    return this.readiness(res);
  }

  /** A bounded, uncached connectivity probe — never the schema check. */
  private async databaseProbe(): Promise<{ ok: boolean }> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.db.$queryRaw`SELECT 1`,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('database probe timed out')),
            DATABASE_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return { ok: true };
    } catch {
      return { ok: false };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
