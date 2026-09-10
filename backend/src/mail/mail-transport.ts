export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}

export interface MailTransport {
  send(email: OutboundEmail): Promise<void>;
}
