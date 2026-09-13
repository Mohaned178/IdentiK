import { Controller, Get } from '@nestjs/common';
import { MailHealth } from '../mail/mail-transport';
import { MailService } from '../mail/mail.service';

export interface HealthView {
  /** `degraded` when a configured dependency — today, the mail relay — is unreachable. */
  status: 'ok' | 'degraded';
  mail: MailHealth;
}

@Controller('health')
export class HealthController {
  constructor(private readonly mail: MailService) {}

  @Get()
  async health(): Promise<HealthView> {
    const mail = await this.mail.health();
    return { status: mail.reachable ? 'ok' : 'degraded', mail };
  }
}
