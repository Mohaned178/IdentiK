import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { HealthController } from './health.controller';

/**
 * Health reports the Instance's configured dependencies — today, the outbound
 * mail relay the Instance Operator configured (ADR-0022) — so a misconfigured
 * Instance is diagnosable without inspecting its storage or logs.
 */
@Module({ imports: [MailModule], controllers: [HealthController] })
export class HealthModule {}
