import { Inject, Injectable } from '@nestjs/common';
import { MAIL_TRANSPORT, MailTransport, OutboundEmail } from './mail-transport';

@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async send(email: OutboundEmail): Promise<void> {
    await this.transport.send(email);
  }
}
