import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { instanceConfig } from '../config/instance-config';
import { assertDatabaseMatchesRelease } from './migration-gate';

/**
 * The Instance's injected data client: one ORM client on the PostgreSQL driver
 * adapter, provided through the `DATABASE` token (ADR-0026, ADR-0027). It owns
 * the connection pool and the startup migration gate, and disconnects when the
 * Instance shuts down. Services use typed models and `$transaction`; the two
 * documented raw exceptions live where they are used.
 *
 * Migrations are an explicit deploy step: the Instance never creates or
 * changes the schema at boot. The gate compares the migrations this release
 * shipped with the database's bookkeeping before the HTTP listener binds.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: instanceConfig().databaseUrl }),
      // SQLite let a unit of work run as long as it needed on its one
      // connection; Prisma's defaults (5s timeout, 2s wait for a connection)
      // would be a new failure mode for large cascades such as a revoke-all.
      // The client-wide budget preserves the Stage 1 facade's policy for every
      // interactive transaction without a per-call wrapper.
      transactionOptions: { maxWait: 10_000, timeout: 30_000 },
    });
  }

  async onModuleInit(): Promise<void> {
    await assertDatabaseMatchesRelease(this);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
