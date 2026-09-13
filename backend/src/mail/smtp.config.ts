/**
 * SMTP connection details come from deployment configuration only (ADR-0022):
 * the Instance Operator holds the trust fabric, and these values are never
 * addressable from the dashboard or Management API. Every error below names
 * the offending variable but never echoes a credential.
 */
export interface SmtpAuth {
  user: string;
  password: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS (port 465-style). */
  secure: boolean;
  /** Refuse to proceed unless STARTTLS is negotiated — the default once credentials are configured. */
  requireTls: boolean;
  /** Present together or not at all; the type carries the invariant. */
  auth: SmtpAuth | null;
  from: string;
}

const IMPLICIT_TLS_PORT = 465;

export function readSmtpSettings(env: NodeJS.ProcessEnv = process.env): SmtpSettings {
  const host = required(env, 'SMTP_HOST');
  const port = smtpPort(env);
  const from = mailFrom(env);
  const auth = smtpAuth(env);

  const secure =
    env.SMTP_SECURE === undefined ? port === IMPLICIT_TLS_PORT : bool(env, 'SMTP_SECURE');
  let requireTls: boolean;
  if (secure) {
    requireTls = false; // implicit TLS already encrypts the session
  } else if (env.SMTP_REQUIRE_TLS !== undefined) {
    requireTls = bool(env, 'SMTP_REQUIRE_TLS');
  } else {
    requireTls = auth !== null; // credentials are never sent over a cleartext session by default
  }

  return { host, port, secure, requireTls, auth, from };
}

function smtpAuth(env: NodeJS.ProcessEnv): SmtpAuth | null {
  const user = optional(env, 'SMTP_USER');
  const password = optional(env, 'SMTP_PASSWORD');
  if (user && !password) {
    throw new Error(
      'SMTP_PASSWORD must be set when SMTP_USER is set — refusing to authenticate with an empty credential.',
    );
  }
  if (!user && password) {
    throw new Error(
      'SMTP_USER must be set when SMTP_PASSWORD is set — refusing to silently drop the configured credential.',
    );
  }
  return user && password ? { user, password } : null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env, name);
  if (value === null) {
    throw new Error(`${name} must be set when MAIL_TRANSPORT_BINDING=smtp.`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function smtpPort(env: NodeJS.ProcessEnv): number {
  const raw = required(env, 'SMTP_PORT');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SMTP_PORT "${raw}" must be an integer between 1 and 65535.`);
  }
  return port;
}

function bool(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined) {
    throw new Error(`${name} must be set to "true" or "false".`);
  }
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} "${raw}" must be "true" or "false".`);
}

/** Require a usable envelope sender, bare or display-name form. */
function mailFrom(env: NodeJS.ProcessEnv): string {
  const from = required(env, 'MAIL_FROM');
  const angled = from.match(/<([^<>]+)>/);
  const address = (angled ? angled[1] : from).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error(
      'MAIL_FROM must be a valid address such as "IdentiK <no-reply@example.com>".',
    );
  }
  return from;
}
