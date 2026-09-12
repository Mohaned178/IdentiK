import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 10 — the short half of "short-lived": authorization codes and access
 * tokens expire. Driven with one-second TTLs through the same deployment
 * configuration an Instance Operator would use, observed over HTTP only.
 */

const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const REDIRECT = 'https://mobile.example.com/callback';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  id_token: string;
  refresh_token: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Short-lived authorization codes and access tokens', () => {
  let instance: Instance;
  let ownerCookie: string;
  let clientId: string;

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return {
      verifier,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
  };

  const signIn = async (challenge: string): Promise<string> => {
    const res = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'openid email profile',
        state: randomBytes(8).toString('base64url'),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      body: { email: END_USER.email, password: END_USER.password },
    });
    if (res.status !== 302) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
    return new URL(res.headers.get('location')!).searchParams.get('code')!;
  };

  const exchangeCode = (code: string, verifier: string): Promise<Response> =>
    instance.request('/api/oidc/token', {
      method: 'POST',
      redirect: 'manual',
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      },
    });

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST, {
      IDENTIK_AUTHORIZATION_CODE_TTL_MS: '1000',
      // Two seconds, not one: the immediate userinfo assertion below races a
      // one-second TTL under full-suite load.
      IDENTIK_ACCESS_TOKEN_TTL_MS: '2000',
    });

    const ceremony = await instance.request('/api/setup', {
      method: 'POST',
      query: { token: instance.setupToken() },
      body: { organizationName: 'Acme', ...OWNER },
    });
    expect(ceremony.status).toBe(201);

    const owner = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: OWNER.email, password: OWNER.password },
    });
    ownerCookie = (owner.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Mobile', type: 'spa' },
    });
    expect(registered.status).toBe(201);
    const application = (
      (await registered.json()) as { application: { id: string; clientId: string } }
    ).application;
    clientId = application.clientId;
    const added = await instance.request(`/api/applications/${application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: REDIRECT },
    });
    expect(added.status).toBe(201);

    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: END_USER,
    });
    expect(signUp.status).toBe(201);
    const mail = (await instance.capturedEmails()).find(
      (entry) => entry.to === END_USER.email && /verify/i.test(entry.subject),
    );
    const verified = await fetch(mail!.body.match(/https?:\/\/\S+/)![0], { redirect: 'manual' });
    expect(verified.status).toBe(302);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('an expired authorization code cannot be exchanged', async () => {
    const { verifier, challenge } = pkce();
    const code = await signIn(challenge);
    await sleep(1100);

    const res = await exchangeCode(code, verifier);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('an access token dies within its short TTL, while its refresh token outlives it', async () => {
    const { verifier, challenge } = pkce();
    const exchange = await exchangeCode(await signIn(challenge), verifier);
    expect(exchange.status).toBe(200);
    const tokens = (await exchange.json()) as TokenResponse;
    expect(tokens.expires_in).toBeLessThanOrEqual(2);

    const userinfo = (token: string): Promise<Response> =>
      instance.request('/api/oidc/userinfo', {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await userinfo(tokens.access_token)).status).toBe(200);

    await sleep(2200);
    expect((await userinfo(tokens.access_token)).status).toBe(401);

    const verdict = await instance.request('/api/oidc/introspect', {
      method: 'POST',
      redirect: 'manual',
      form: { token: tokens.access_token, client_id: clientId },
    });
    expect(await verdict.json()).toEqual({ active: false });

    // The refresh token is not an access token: it is bound to the Session,
    // not to the short TTL, and still rotates after the access token is gone.
    const rotated = await instance.request('/api/oidc/token', {
      method: 'POST',
      redirect: 'manual',
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      },
    });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as TokenResponse;
    expect(next.access_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
  });
});
