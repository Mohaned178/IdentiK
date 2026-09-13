import { Inject, Injectable } from '@nestjs/common';
import {
  MAIL_TRANSPORT,
  MailHealth,
  MailTransport,
  OutboundEmail,
} from './mail-transport';

@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async send(email: OutboundEmail): Promise<void> {
    await this.transport.send(email);
  }

  /**
   * The deployment binding and relay reachability for the public health
   * surface. The endpoint and failure reason stay in the startup log, where
   * the Instance Operator can read them without exposing infrastructure to
   * anonymous callers.
   */
  async health(): Promise<MailHealth> {
    return {
      binding: this.transport.binding,
      reachable: (await this.transport.status()).reachable,
    };
  }
}
