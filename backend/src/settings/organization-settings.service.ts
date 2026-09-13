import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { recordAuditEvent } from '../storage/audit';
import { DATABASE, Database } from '../storage/token';

export interface Branding {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
}

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

export interface SessionPolicy {
  idleTimeoutMs: number;
}

export interface OrganizationSettingsView {
  branding: Branding;
  passwordPolicy: PasswordPolicy;
  sessionPolicy: SessionPolicy;
}

/** A password rejected by the Organization's policy, with the first reason. */
export interface PasswordProblem {
  code:
    | 'min_length'
    | 'require_uppercase'
    | 'require_lowercase'
    | 'require_digit'
    | 'require_symbol';
  message: string;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: false,
  requireLowercase: false,
  requireDigit: false,
  requireSymbol: false,
};

export const DEFAULT_BRANDING_COLORS = {
  primaryColor: '#2563eb',
  secondaryColor: '#1e40af',
};

export const MIN_IDLE_TIMEOUT_MS = 1000;
export const MAX_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_IDLE_TIMEOUT_MS = MAX_IDLE_TIMEOUT_MS;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_BRANDING_NAME = 100;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The one list of Organization-scoped sections: API field name → storage key.
 * Everything else — the update allowlist, the stored-row lookup — derives from
 * it, so a new setting is added in one place and the trust fabric stays
 * unaddressable by construction.
 */
const ORG_SECTIONS = {
  branding: 'branding',
  passwordPolicy: 'password_policy',
  sessionPolicy: 'session_policy',
} as const;

type SectionField = keyof typeof ORG_SECTIONS;
type SectionKey = (typeof ORG_SECTIONS)[SectionField];

interface StoredRow {
  value: string;
}

interface SectionUpdate {
  key: SectionKey;
  auditKind: string;
  value: unknown;
  detail: Record<string, unknown>;
}

/**
 * The Organization-scoped half of the settings boundary (ADR-0022): branding,
 * password policy, and session timeout. Owners change it through the
 * Management API, every change is an audit event, and the deployed defaults
 * serve until a row exists. The instance-scoped trust fabric — SMTP transport,
 * signing keys, trusted external providers — is deliberately not represented
 * here, and the update edge refuses any key that is not one of the three
 * Organization-scoped sections.
 *
 * The policy floors are enforced where credentials are set (sign-up,
 * password change and reset) and where Sessions lapse (idle expiry), not in
 * the dashboard: the API is the only surface, so the rule lives in one place.
 */
@Injectable()
export class OrganizationSettingsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The effective settings: stored values merged over the deployed defaults. */
  async view(organizationId: string): Promise<OrganizationSettingsView> {
    return {
      branding: await this.branding(organizationId),
      passwordPolicy: await this.passwordPolicy(organizationId),
      sessionPolicy: await this.sessionPolicy(organizationId),
    };
  }

  async branding(organizationId: string): Promise<Branding> {
    return {
      name: await this.organizationName(organizationId),
      logoUrl: null,
      ...DEFAULT_BRANDING_COLORS,
      ...((await this.stored<Branding>(organizationId, 'branding')) ?? {}),
    };
  }

  async passwordPolicy(organizationId: string): Promise<PasswordPolicy> {
    return {
      ...DEFAULT_PASSWORD_POLICY,
      ...((await this.stored<PasswordPolicy>(organizationId, 'password_policy')) ?? {}),
    };
  }

  async sessionPolicy(organizationId: string): Promise<SessionPolicy> {
    return {
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      ...((await this.stored<SessionPolicy>(organizationId, 'session_policy')) ?? {}),
    };
  }

  /**
   * The idle window a Session lapses after, refreshed by every activity. Reads
   * only the session policy row: this is on the hot path of every Session
   * resolution.
   */
  async idleTimeoutMs(organizationId: string): Promise<number> {
    const row = await this.stored<SessionPolicy>(organizationId, 'session_policy');
    return row?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Apply an Owner's settings edit. The body is untrusted JSON: unknown keys —
   * at the top level or nested inside a known section — are refused before
   * anything is written, so no Organization-scoped path can address the trust
   * fabric. All provided sections are validated as one unit, then persisted
   * and audited as one transaction.
   */
  async update(
    organizationId: string,
    actor: string,
    body: unknown,
  ): Promise<OrganizationSettingsView> {
    const input = this.parseUpdate(body);
    const current = await this.view(organizationId);

    const updates: SectionUpdate[] = [];
    if (input.branding !== undefined) {
      const value = mergeBranding(current.branding, input.branding);
      if (changed(value, current.branding)) {
        updates.push({
          key: ORG_SECTIONS.branding,
          auditKind: 'organization.branding.updated',
          value,
          detail: { ...value },
        });
      }
    }
    if (input.passwordPolicy !== undefined) {
      const value = mergePasswordPolicy(current.passwordPolicy, input.passwordPolicy);
      if (changed(value, current.passwordPolicy)) {
        updates.push({
          key: ORG_SECTIONS.passwordPolicy,
          auditKind: 'organization.password_policy.updated',
          value,
          detail: { ...value },
        });
      }
    }
    if (input.sessionPolicy !== undefined) {
      const value = mergeSessionPolicy(current.sessionPolicy, input.sessionPolicy);
      if (changed(value, current.sessionPolicy)) {
        updates.push({
          key: ORG_SECTIONS.sessionPolicy,
          auditKind: 'organization.session_policy.updated',
          value,
          detail: { ...value },
        });
      }
    }
    if (updates.length === 0) return current;

    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      for (const update of updates) {
        await tx.run(
          `INSERT INTO organization_settings (organization_id, key, value, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (organization_id, key)
             DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                           updated_at = excluded.updated_at`,
          [organizationId, update.key, JSON.stringify(update.value), actor, now],
        );
        await recordAuditEvent(tx, {
          organizationId,
          actor,
          kind: update.auditKind,
          detail: update.detail,
        });
      }
    });
    return this.view(organizationId);
  }

  private async organizationName(organizationId: string): Promise<string> {
    const organization = await this.db.get<{ name: string }>(
      'SELECT name FROM organizations WHERE id = ?',
      [organizationId],
    );
    return organization?.name ?? '';
  }

  private async stored<T>(
    organizationId: string,
    key: SectionKey,
  ): Promise<Partial<T> | undefined> {
    const row = await this.db.get<StoredRow>(
      'SELECT value FROM organization_settings WHERE organization_id = ? AND key = ?',
      [organizationId, key],
    );
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as Partial<T>;
    } catch {
      return undefined;
    }
  }

  /**
   * An untrusted settings document reduced to the three Organization-scoped
   * sections. Anything else at the top level is instance-scoped trust fabric
   * and is refused with a plain 400 — the boundary is the allowlist itself.
   */
  private parseUpdate(body: unknown): {
    branding?: unknown;
    passwordPolicy?: unknown;
    sessionPolicy?: unknown;
  } {
    if (!isPlainObject(body)) {
      throw invalidSetting('the request body must be a JSON object');
    }
    const fields = Object.keys(ORG_SECTIONS) as SectionField[];
    for (const key of Object.keys(body)) {
      if (!fields.includes(key as SectionField)) {
        throw new BadRequestException({
          error: 'instance_scoped_setting',
          message: `"${key}" is not an Organization-scoped setting and cannot be changed through the Management API`,
        });
      }
    }
    if (!fields.some((field) => body[field] !== undefined)) {
      throw invalidSetting(`provide at least one of ${fields.join(', ')}`);
    }
    return body;
  }
}

function changed(next: unknown, current: unknown): boolean {
  return JSON.stringify(next) !== JSON.stringify(current);
}

/** Validate a candidate password against the Organization's policy. */
export function firstPasswordProblem(
  policy: PasswordPolicy,
  password: string,
): PasswordProblem | null {
  if (password.length < policy.minLength) {
    return {
      code: 'min_length',
      message: `the password must be at least ${policy.minLength} characters long`,
    };
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    return { code: 'require_uppercase', message: 'the password must contain an uppercase letter' };
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    return { code: 'require_lowercase', message: 'the password must contain a lowercase letter' };
  }
  if (policy.requireDigit && !/[0-9]/.test(password)) {
    return { code: 'require_digit', message: 'the password must contain a digit' };
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    return { code: 'require_symbol', message: 'the password must contain a symbol' };
  }
  return null;
}

function mergeBranding(current: Branding, input: unknown): Branding {
  const fields = requireSection('branding', input);
  const merged: Branding = { ...current };
  for (const key of Object.keys(fields)) {
    switch (key) {
      case 'name':
        merged.name = fields.name as string;
        break;
      case 'logoUrl':
        merged.logoUrl = fields.logoUrl as string | null;
        break;
      case 'primaryColor':
        merged.primaryColor = fields.primaryColor as string;
        break;
      case 'secondaryColor':
        merged.secondaryColor = fields.secondaryColor as string;
        break;
      default:
        throw invalidSetting(`"branding.${key}" is not a recognized branding field`);
    }
  }
  return validateBranding(merged);
}

function validateBranding(branding: Branding): Branding {
  if (typeof branding.name !== 'string') {
    throw invalidSetting('branding.name must be a string');
  }
  const name = branding.name.trim();
  if (name.length < 1 || name.length > MAX_BRANDING_NAME) {
    throw invalidSetting(`branding.name must be between 1 and ${MAX_BRANDING_NAME} characters`);
  }
  if (branding.logoUrl !== null) {
    if (typeof branding.logoUrl !== 'string' || !absoluteHttpUrl(branding.logoUrl)) {
      throw invalidSetting('branding.logoUrl must be an absolute http(s) URL or null');
    }
  }
  if (typeof branding.primaryColor !== 'string' || !HEX_COLOR.test(branding.primaryColor)) {
    throw invalidSetting('branding.primaryColor must be a hex color like #2563eb');
  }
  if (typeof branding.secondaryColor !== 'string' || !HEX_COLOR.test(branding.secondaryColor)) {
    throw invalidSetting('branding.secondaryColor must be a hex color like #1e40af');
  }
  return { ...branding, name };
}

function mergePasswordPolicy(current: PasswordPolicy, input: unknown): PasswordPolicy {
  const fields = requireSection('passwordPolicy', input);
  const merged: PasswordPolicy = { ...current };
  for (const key of Object.keys(fields)) {
    switch (key) {
      case 'minLength':
        merged.minLength = fields.minLength as number;
        break;
      case 'requireUppercase':
        merged.requireUppercase = fields.requireUppercase as boolean;
        break;
      case 'requireLowercase':
        merged.requireLowercase = fields.requireLowercase as boolean;
        break;
      case 'requireDigit':
        merged.requireDigit = fields.requireDigit as boolean;
        break;
      case 'requireSymbol':
        merged.requireSymbol = fields.requireSymbol as boolean;
        break;
      default:
        throw invalidSetting(`"passwordPolicy.${key}" is not a recognized password policy field`);
    }
  }
  return validatePasswordPolicy(merged);
}

function validatePasswordPolicy(policy: PasswordPolicy): PasswordPolicy {
  if (
    !Number.isInteger(policy.minLength) ||
    policy.minLength < MIN_PASSWORD_LENGTH ||
    policy.minLength > MAX_PASSWORD_LENGTH
  ) {
    throw invalidSetting(
      `passwordPolicy.minLength must be an integer between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}`,
    );
  }
  for (const key of [
    'requireUppercase',
    'requireLowercase',
    'requireDigit',
    'requireSymbol',
  ] as const) {
    if (typeof policy[key] !== 'boolean') {
      throw invalidSetting(`passwordPolicy.${key} must be a boolean`);
    }
  }
  return policy;
}

function mergeSessionPolicy(current: SessionPolicy, input: unknown): SessionPolicy {
  const fields = requireSection('sessionPolicy', input);
  const merged: SessionPolicy = { ...current };
  for (const key of Object.keys(fields)) {
    switch (key) {
      case 'idleTimeoutMs':
        merged.idleTimeoutMs = fields.idleTimeoutMs as number;
        break;
      default:
        throw invalidSetting(`"sessionPolicy.${key}" is not a recognized session policy field`);
    }
  }
  if (
    !Number.isInteger(merged.idleTimeoutMs) ||
    merged.idleTimeoutMs < MIN_IDLE_TIMEOUT_MS ||
    merged.idleTimeoutMs > MAX_IDLE_TIMEOUT_MS
  ) {
    throw invalidSetting(
      `sessionPolicy.idleTimeoutMs must be an integer between ${MIN_IDLE_TIMEOUT_MS} and ${MAX_IDLE_TIMEOUT_MS}`,
    );
  }
  return merged;
}

function requireSection(name: string, value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalidSetting(`${name} must be a JSON object`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function absoluteHttpUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function invalidSetting(message: string): BadRequestException {
  return new BadRequestException({ error: 'invalid_setting', message });
}
