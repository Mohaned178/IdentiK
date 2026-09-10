import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { InMemoryMailTransport } from './in-memory-mail.transport';
import { DevMailController } from './dev-mail.controller';
import { MAIL_TRANSPORT, MailTransport } from './mail-transport';

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

@Module({
  providers: [
    MailService,
    InMemoryMailTransport,
    {
      provide: MAIL_TRANSPORT,
      inject: [InMemoryMailTransport],
      useFactory: (capture: InMemoryMailTransport): MailTransport =>
        binding === 'smtp'
          ? // Production SMTP binding arrives in ticket 20; until then an
            // SMTP-configured instance fails fast rather than silently capturing.
            (() => {
              throw new Error(
                'SMTP transport binding is not implemented yet (ticket 20); ' +
                  'start the Instance without MAIL_TRANSPORT_BINDING=smtp.',
              );
            })()
          : capture,
    },
  ],
  controllers: binding === 'capture' ? [DevMailController] : [],
  exports: [MailService],
})
export class MailModule {}
