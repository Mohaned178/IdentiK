import { Injectable } from '@nestjs/common';
import { MailTransport, OutboundEmail } from './mail-transport';

export interface CapturedEmail extends OutboundEmail {
  sentAt: string;
}

@Injectable()
export class InMemoryMailTransport implements MailTransport {
  private readonly captured: CapturedEmail[] = [];

  async send(email: OutboundEmail): Promise<void> {
    this.captured.push({ ...email, sentAt: new Date().toISOString() });
  }

  list(): CapturedEmail[] {
    return [...this.captured];
  }
}
