import { Module, Provider } from '@nestjs/common';
import { instanceConfig } from '../config/instance-config';
import { MailService } from './mail.service';
import { InMemoryMailTransport } from './in-memory-mail.transport';
import { SmtpMailTransport } from './smtp.transport';
import { DevMailController } from './dev-mail.controller';
import { MAIL_TRANSPORT } from './mail-transport';

/**
 * The mail binding the validated deployment configuration selected. `capture`
 * keeps the in-memory binding whose /dev/mail surface is development-only and
 * refused outside the development opt-in; `smtp` delivers through the
 * Instance Operator's relay with connection details read from deployment
 * configuration (ADR-0022). Callers never see the difference.
 */
const capture = instanceConfig().mailBinding === 'capture';

const transportProviders: Provider[] = capture
  ? [
      InMemoryMailTransport,
      { provide: MAIL_TRANSPORT, useExisting: InMemoryMailTransport },
    ]
  : [
      SmtpMailTransport,
      { provide: MAIL_TRANSPORT, useExisting: SmtpMailTransport },
    ];

@Module({
  providers: [MailService, ...transportProviders],
  controllers: capture ? [DevMailController] : [],
  exports: [MailService],
})
export class MailModule {}
