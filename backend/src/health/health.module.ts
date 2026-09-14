import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { StorageModule } from '../storage/storage.module';
import { HealthController } from './health.controller';

/**
 * Health reports the Instance's configured dependencies — the database it
 * reads and writes, and the outbound mail relay the Instance Operator
 * configured (ADR-0022) — so a misconfigured or unavailable dependency is
 * diagnosable without inspecting storage or logs.
 */
@Module({ imports: [MailModule, StorageModule], controllers: [HealthController] })
export class HealthModule {}
