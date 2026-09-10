import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { InMemoryMailTransport } from './in-memory-mail.transport';
import { DevMailController } from './dev-mail.controller';
import { MAIL_TRANSPORT, MailTransport } from './mail-transport';

/** True when the Instance Operator configured real SMTP (production mode). */
const smtpConfigured = process.env.MAIL_TRANSPORT_BINDING === 'smtp';

@Module({
  providers: [
    MailService,
    InMemoryMailTransport,
    {
      provide: MAIL_TRANSPORT,
      inject: [InMemoryMailTransport],
      useFactory: (capture: InMemoryMailTransport): MailTransport =>
        smtpConfigured
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
  controllers: smtpConfigured ? [] : [DevMailController],
  exports: [MailService],
})
export class MailModule {}
