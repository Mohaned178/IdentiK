import type { MailBinding } from '../mail/mail-transport';
import { readSmtpSettings, type SmtpSettings } from '../mail/smtp.config';
import { optionalEnv } from './env-var';

/**
 * The Instance's validated deployment configuration (ADR-0022): the trust
 * fabric the Instance Operator holds. One schema, evaluated once at startup
 * before the HTTP listener binds. A missing or invalid value exits the process
 * with the setting named; a present-but-invalid duration, count, or port is
 * never silently defaulted; and the development-only fallbacks — the captured
 * mail binding and ephemeral signing keys — are refused unless
 * `IDENTIK_DEV_MODE=1` is explicitly set.
 */
export class ConfigurationError extends Error {}

export interface InstanceConfiguration {
  readonly devMode: boolean;
  readonly port: number;
  readonly databaseUrl: string;
  /** The deployed public origin, without a trailing slash. */
  readonly baseUrl: string;
  readonly mailBinding: MailBinding;
  readonly signingJwks: string | null;
  readonly smtp: SmtpSettings | null;
  /** Present-and-validated durations by variable name; absent names keep call-site defaults. */
  readonly durations: ReadonlyMap<string, number>;
  /** Present-and-validated counts by variable name; absent names keep call-site defaults. */
  readonly counts: ReadonlyMap<string, number>;
}

/**
 * Every duration and count the Instance consumes. Listing them here is what
 * turns a typo anywhere in the deployment environment into a startup failure
 * instead of a silent fallback: startup validation walks the whole list, and
 * the name unions below stop a typo at the call site from compiling.
 */
const DURATION_NAMES = [
  'IDENTIK_SETUP_TOKEN_TTL_MS',
  'IDENTIK_SESSION_TTL_MS',
  'IDENTIK_VERIFICATION_TOKEN_TTL_MS',
  'IDENTIK_RESET_TOKEN_TTL_MS',
  'IDENTIK_EMAIL_CHANGE_TOKEN_TTL_MS',
  'IDENTIK_INVITATION_TOKEN_TTL_MS',
  'IDENTIK_AUTHORIZATION_CODE_TTL_MS',
  'IDENTIK_ACCESS_TOKEN_TTL_MS',
  'IDENTIK_REFRESH_TOKEN_TTL_MS',
  'IDENTIK_THROTTLE_WINDOW_MS',
  'IDENTIK_THROTTLE_BASE_DELAY_MS',
  'IDENTIK_THROTTLE_MAX_DELAY_MS',
] as const;

const COUNT_NAMES = ['IDENTIK_THROTTLE_AFTER_ATTEMPTS'] as const;

export type DurationName = (typeof DURATION_NAMES)[number];
export type CountName = (typeof COUNT_NAMES)[number];

const DEFAULT_PORT = 3000;

let cached: InstanceConfiguration | null = null;

/** The process-wide validated configuration, loaded once on first access. */
export function instanceConfig(): InstanceConfiguration {
  cached ??= loadInstanceConfiguration(process.env);
  return cached;
}

export function loadInstanceConfiguration(env: NodeJS.ProcessEnv): InstanceConfiguration {
  const devMode = parseDevMode(env);
  const port = parsePort(env);
  const databaseUrl = parseDatabaseUrl(env);
  const baseUrl = parseBaseUrl(env);
  const mailBinding = parseMailBinding(env);

  if (mailBinding === 'capture' && !devMode) {
    throw new ConfigurationError(
      'MAIL_TRANSPORT_BINDING=capture is development-only; set IDENTIK_DEV_MODE=1 ' +
        'to run the in-memory transport for tests and local development.',
    );
  }

  const signingJwks = optionalEnv(env, 'IDENTIK_SIGNING_JWKS');
  if (signingJwks === null && !devMode) {
    throw new ConfigurationError(
      'IDENTIK_SIGNING_JWKS must be set to a stable signing key set; set ' +
        'IDENTIK_DEV_MODE=1 to allow an ephemeral development key.',
    );
  }

  return {
    devMode,
    port,
    databaseUrl,
    baseUrl,
    mailBinding,
    signingJwks,
    smtp: mailBinding === 'smtp' ? readSmtpSettings(env) : null,
    durations: numbers(env, DURATION_NAMES, parseDuration),
    counts: numbers(env, COUNT_NAMES, parseCount),
  };
}

function parseDevMode(env: NodeJS.ProcessEnv): boolean {
  const raw = optionalEnv(env, 'IDENTIK_DEV_MODE');
  if (raw === null) return false;
  if (raw === '1') return true;
  throw new ConfigurationError(
    `IDENTIK_DEV_MODE "${raw}" must be "1" when set — nothing else enables development mode.`,
  );
}

function parsePort(env: NodeJS.ProcessEnv): number {
  const raw = optionalEnv(env, 'PORT');
  if (raw === null) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`PORT "${raw}" must be an integer between 1 and 65535.`);
  }
  return port;
}

function parseDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = required(
    env,
    'DATABASE_URL',
    'DATABASE_URL must be set to the PostgreSQL connection URL',
  );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError('DATABASE_URL must be an absolute PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ConfigurationError('DATABASE_URL must use the postgres:// or postgresql:// scheme');
  }
  if (parsed.hostname.length === 0) {
    throw new ConfigurationError('DATABASE_URL must name a PostgreSQL host');
  }
  if (parsed.pathname.length <= 1) {
    throw new ConfigurationError('DATABASE_URL must name a database');
  }
  return url;
}

function parseBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = required(
    env,
    'IDENTIK_BASE_URL',
    'IDENTIK_BASE_URL must be set to the externally reachable URL of this Instance ' +
      '(e.g. https://id.example.com) — it is the base for verification and reset links.',
  );
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(`IDENTIK_BASE_URL "${raw}" is not a valid absolute URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(`IDENTIK_BASE_URL "${raw}" must be an http(s) URL.`);
  }
  return raw.replace(/\/+$/, '');
}

function parseMailBinding(env: NodeJS.ProcessEnv): MailBinding {
  const raw = optionalEnv(env, 'MAIL_TRANSPORT_BINDING');
  if (raw === null) {
    throw new ConfigurationError(
      'MAIL_TRANSPORT_BINDING must be set to "capture" or "smtp" — the captured-mail ' +
        'transport is never selected implicitly because its /dev/mail surface is unauthenticated.',
    );
  }
  if (raw !== 'capture' && raw !== 'smtp') {
    throw new ConfigurationError(
      `Unknown MAIL_TRANSPORT_BINDING "${raw}" — expected "capture" or "smtp".`,
    );
  }
  return raw;
}

function numbers(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  parse: (name: string, raw: string) => number,
): ReadonlyMap<string, number> {
  const values = new Map<string, number>();
  for (const name of names) {
    const raw = optionalEnv(env, name);
    if (raw !== null) values.set(name, parse(name, raw));
  }
  return values;
}

function parseDuration(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(
      `"${name}" is "${raw}"; it must be a positive number of milliseconds.`,
    );
  }
  return value;
}

function parseCount(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(`"${name}" is "${raw}"; it must be a non-negative whole number.`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string, message: string): string {
  const value = optionalEnv(env, name);
  if (value === null) throw new ConfigurationError(message);
  return value;
}
