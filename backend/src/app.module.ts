import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';

@Module({
  imports: [HealthModule, MailModule],
})
export class AppModule {}
