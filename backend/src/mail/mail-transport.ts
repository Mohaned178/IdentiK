export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/**
 * The outbound mail binding the Instance Operator selected in deployment
 * configuration (ADR-0022): `capture` is the in-memory test binding,
 * `smtp` the production relay.
 */
export type MailBinding = 'capture' | 'smtp';

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}

/** The transport's self-description for diagnostics; never carries credentials. */
export interface MailTransportStatus {
  reachable: boolean;
  error?: string;
}

/** The public health view: binding and reachability only — never infrastructure detail. */
export interface MailHealth {
  binding: MailBinding;
  reachable: boolean;
}

export interface MailTransport {
  readonly binding: MailBinding;
  send(email: OutboundEmail): Promise<void>;
  status(): Promise<MailTransportStatus>;
}
