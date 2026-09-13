import { Module, Provider } from '@nestjs/common';
import { MailService } from './mail.service';
import { InMemoryMailTransport } from './in-memory-mail.transport';
import { SmtpMailTransport } from './smtp.transport';
import { DevMailController } from './dev-mail.controller';
import { MAIL_TRANSPORT } from './mail-transport';

/** Binding the Instance Operator selected for outbound mail. */
const binding = process.env.MAIL_TRANSPORT_BINDING;

if (!binding) {
  throw new Error(
    'MAIL_TRANSPORT_BINDING must be set to "capture" or "smtp" — the captured-mail ' +
      'transport is never selected implicitly because its /dev/mail surface is unauthenticated.',
  );
}

if (binding !== 'capture' && binding !== 'smtp') {
  throw new Error(
    `Unknown MAIL_TRANSPORT_BINDING "${binding}" — expected "capture" or "smtp".`,
  );
}

/**
 * One transport per configuration, bound to the same seam: `capture` keeps the
 * in-memory binding whose /dev/mail surface is test-only, `smtp` delivers
 * through the Instance Operator's relay with connection details read from
 * deployment configuration (ADR-0022). Callers never see the difference.
 */
const capture = binding === 'capture';
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
