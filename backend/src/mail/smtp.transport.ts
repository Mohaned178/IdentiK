import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { MailTransport, MailTransportStatus, OutboundEmail } from './mail-transport';
import { readSmtpSettings } from './smtp.config';

/** How long a reachability verdict is trusted before the relay is probed again. */
const STATUS_CACHE_MS = 5_000;

/**
 * The production outbound mail binding (ADR-0022): every platform mail —
 * verification, reset, invitation, email change — is handed to the SMTP relay
 * the Instance Operator configured in deployment configuration. The connection
 * is verified at boot and on demand for /health; an unreachable relay is
 * reported there, never fatal, because the relay may recover and mail is only
 * needed when a mailbox-proof flow runs. No credential ever reaches a log,
 * an error message, or the health response: diagnostics are sanitized against
 * every configured secret before they are surfaced.
 */
@Injectable()
export class SmtpMailTransport implements MailTransport, OnModuleInit {
  readonly binding = 'smtp' as const;
  readonly endpoint: string;

  private readonly logger = new Logger(SmtpMailTransport.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly secrets: string[];
  private cached: { at: number; status: MailTransportStatus } | null = null;

  constructor() {
    const settings = readSmtpSettings();
    this.endpoint = `${settings.host}:${settings.port}`;
    this.from = settings.from;
    this.secrets = settings.auth ? [settings.auth.password, settings.auth.user] : [];
    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: settings.requireTls,
      auth: settings.auth
        ? { user: settings.auth.user, pass: settings.auth.password }
        : undefined,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }

  /**
   * Boot diagnostic. Deliberately not awaited: a relay that is briefly down
   * must not delay or prevent the Instance from serving.
   */
  onModuleInit(): void {
    void this.check().then((status) => {
      if (status.reachable) {
        this.logger.log(`SMTP relay at ${this.endpoint} is reachable`);
      } else {
        this.logger.error(`SMTP relay at ${this.endpoint} is unreachable: ${status.error}`);
      }
    });
  }

  async send(email: OutboundEmail): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: email.to,
        subject: email.subject,
        text: email.body,
      });
      this.record({ reachable: true });
    } catch (error) {
      const failure = this.sanitize(error);
      this.record({ reachable: false, error: failure });
      throw new Error(`SMTP relay at ${this.endpoint} refused delivery: ${failure}`);
    }
  }

  async status(): Promise<MailTransportStatus> {
    if (this.cached && Date.now() - this.cached.at < STATUS_CACHE_MS) {
      return this.cached.status;
    }
    return this.check();
  }

  private async check(): Promise<MailTransportStatus> {
    try {
      await this.transporter.verify();
      return this.record({ reachable: true });
    } catch (error) {
      return this.record({ reachable: false, error: this.sanitize(error) });
    }
  }

  private record(status: MailTransportStatus): MailTransportStatus {
    this.cached = { at: Date.now(), status };
    return status;
  }

  /** Strip every configured credential from a diagnostic before it is surfaced. */
  private sanitize(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of this.secrets) {
      message = message.split(secret).join('[redacted]');
    }
    return message;
  }
}
