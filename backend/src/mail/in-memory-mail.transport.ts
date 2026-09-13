import { Injectable } from '@nestjs/common';
import { MailTransport, MailTransportStatus, OutboundEmail } from './mail-transport';

export interface CapturedEmail extends OutboundEmail {
  sentAt: string;
}

@Injectable()
export class InMemoryMailTransport implements MailTransport {
  readonly binding = 'capture' as const;

  private readonly captured: CapturedEmail[] = [];

  async send(email: OutboundEmail): Promise<void> {
    this.captured.push({ ...email, sentAt: new Date().toISOString() });
  }

  async status(): Promise<MailTransportStatus> {
    return { reachable: true };
  }

  list(): CapturedEmail[] {
    return [...this.captured];
  }
}
