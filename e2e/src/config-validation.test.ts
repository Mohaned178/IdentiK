import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

const SMTP_ENV = {
  MAIL_TRANSPORT_BINDING: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '2525',
  MAIL_FROM: 'IdentiK <no-reply@identik.test>',
};

/**
 * Ticket 01 — fail-closed configuration. Every refusal is observed the way a
 * failed startup is: the process exits before becoming healthy and its output
 * names the setting. The harness sets the development opt-in by default; the
 * production-strict tests clear it explicitly.
 */
async function expectStartupRefusal(
  env: Record<string, string>,
  pattern: RegExp,
): Promise<void> {
  let started: Instance | undefined;
  try {
    started = await Instance.start(BACKEND_DIST, env);
  } catch (error) {
    expect(String(error)).toMatch(pattern);
    return;
  }
  await started.stop();
  throw new Error('expected the Instance to refuse to start, but it served traffic');
}

async function expectBoots(env: Record<string, string>): Promise<void> {
  const instance = await Instance.start(BACKEND_DIST, env);
  try {
    const res = await instance.request('/health');
    expect(res.status).toBe(200);
  } finally {
    await instance.stop();
  }
}

/** A private RSA JWK, the shape IDENTIK_SIGNING_JWKS carries. */
async function signingJwks(): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return JSON.stringify([await exportJWK(privateKey)]);
}

describe('production-strict defaults', () => {
  it('refuses the captured-mail binding without the development opt-in', async () => {
    await expectStartupRefusal(
      { IDENTIK_DEV_MODE: '', MAIL_TRANSPORT_BINDING: 'capture' },
      /MAIL_TRANSPORT_BINDING|capture/,
    );
  });

  it('requires a stable signing key set without the development opt-in', async () => {
    await expectStartupRefusal({ IDENTIK_DEV_MODE: '', ...SMTP_ENV }, /IDENTIK_SIGNING_JWKS/);
  });

  it('refuses an unknown mail binding', async () => {
    await expectStartupRefusal({ MAIL_TRANSPORT_BINDING: 'pigeon' }, /MAIL_TRANSPORT_BINDING/);
  });
});

describe('invalid values are fatal, never silently defaulted', () => {
  it('refuses a present-but-invalid duration', async () => {
    await expectStartupRefusal(
      { IDENTIK_ACCESS_TOKEN_TTL_MS: 'soon' },
      /IDENTIK_ACCESS_TOKEN_TTL_MS/,
    );
  });

  it('refuses a present-but-invalid count', async () => {
    await expectStartupRefusal(
      { IDENTIK_THROTTLE_AFTER_ATTEMPTS: '-3' },
      /IDENTIK_THROTTLE_AFTER_ATTEMPTS/,
    );
  });

  it('refuses an invalid port', async () => {
    await expectStartupRefusal({ PORT: 'not-a-port' }, /PORT/);
  });
});

describe('required settings are named when missing', () => {
  it('refuses a missing database URL', async () => {
    await expectStartupRefusal({ DATABASE_URL: '' }, /DATABASE_URL/);
  });

  it('refuses a missing base URL', async () => {
    await expectStartupRefusal({ IDENTIK_BASE_URL: '' }, /IDENTIK_BASE_URL/);
  });

  it('refuses a missing mail binding', async () => {
    await expectStartupRefusal({ MAIL_TRANSPORT_BINDING: '' }, /MAIL_TRANSPORT_BINDING/);
  });
});

describe('the development opt-in', () => {
  it('permits the captured-mail binding and ephemeral signing keys', async () => {
    await expectBoots({ IDENTIK_DEV_MODE: '1', MAIL_TRANSPORT_BINDING: 'capture' });
  });
});

describe('production-strict boot', () => {
  it('boots with a stable signing key set and the smtp binding', async () => {
    await expectBoots({
      IDENTIK_DEV_MODE: '',
      IDENTIK_SIGNING_JWKS: await signingJwks(),
      ...SMTP_ENV,
    });
  });
});
