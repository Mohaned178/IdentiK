import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 10 — Token issuance: code exchange + PKCE, signed JWTs, JWKS,
 * discovery, userinfo, rotating refresh tokens (ADR-0013, ADR-0015).
 *
 * Observed only through Seam 1 (HTTP): discovery and JWKS over HTTP, the
 * authorization endpoint from ticket 09 to obtain codes, the token endpoint to
 * exchange them, and a stock OIDC client library (openid-client) acting as
 * Zotac — the zero-SDK assertion, executable. No test looks inside the
 * database or at module structure.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const HEALED = { email: 'healer@example.com', password: 'healer password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const MOBILE_REDIRECT = 'https://mobile.example.com/callback';

interface ApplicationView {
  id: string;
  clientId: string;
  secrets: Array<{ id: string; label: string }>;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token: string;
  refresh_token: string;
  scope: string;
}

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in email body');
  return match[0];
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function basicAuth(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}

describe('Token issuance: exchange, JWTs, JWKS, discovery, userinfo, refresh', () => {
  let instance: Instance;
  let ownerCookie: string;
  let zotac: { id: string; clientId: string; secret: string };
  let mobile: { id: string; clientId: string };

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return {
      verifier,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
  };

  const registerApplication = async (
    name: string,
    type: 'web' | 'spa',
    redirectUri: string,
  ): Promise<{ id: string; clientId: string; secret: string }> => {
    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name, type },
    });
    expect(registered.status).toBe(201);
    const body = (await registered.json()) as {
      application: ApplicationView;
      clientSecret: string | null;
    };
    const added = await instance.request(`/api/applications/${body.application.id}/redirect-uris`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { uri: redirectUri },
    });
    expect(added.status).toBe(201);
    return {
      id: body.application.id,
      clientId: body.application.clientId,
      secret: body.clientSecret ?? '',
    };
  };

  const signUpAndVerify = async (endUser: { email: string; password: string }): Promise<void> => {
    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: endUser,
    });
    expect(signUp.status).toBe(201);
    const mail = (await instance.capturedEmails())
      .filter((entry) => entry.to === endUser.email && /verify/i.test(entry.subject))
      .at(-1);
    if (!mail) throw new Error(`no verification mail for ${endUser.email}`);
    const verified = await fetch(linkFromBody(mail.body), { redirect: 'manual' });
    expect(verified.status).toBe(302);
  };

  const signIn = async (options: {
    clientId: string;
    redirectUri: string;
    scope?: string;
    nonce?: string;
    codeChallenge?: string;
    email?: string;
    password?: string;
    cookie?: string;
  }): Promise<{ code: string; cookie: string | null }> => {
    const res = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: 'code',
        scope: options.scope ?? 'openid email profile',
        state: randomBytes(8).toString('base64url'),
        ...(options.nonce ? { nonce: options.nonce } : {}),
        ...(options.codeChallenge
          ? { code_challenge: options.codeChallenge, code_challenge_method: 'S256' }
          : {}),
      },
      body: {
        email: options.email ?? END_USER.email,
        password: options.password ?? END_USER.password,
      },
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    });
    if (res.status !== 302) {
      throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
    }
    const location = new URL(res.headers.get('location')!);
    const code = location.searchParams.get('code');
    if (!code) throw new Error(`no code in ${location}`);
    const setCookie = res.headers.get('set-cookie');
    return { code, cookie: setCookie ? setCookie.split(';')[0]! : null };
  };

  const exchange = (
    form: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<Response> =>
    instance.request('/api/oidc/token', {
      method: 'POST',
      form,
      headers,
      redirect: 'manual',
    });

  const expectTokenBody = async (res: Response): Promise<TokenResponse> => {
    const body = (await res.json()) as TokenResponse;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    return body;
  };

  const publicFlow = async (
    options: { scope?: string; nonce?: string } = {},
  ): Promise<{ body: TokenResponse; verifier: string; nonce: string }> => {
    const { verifier, challenge } = pkce();
    const nonce = options.nonce ?? randomBytes(8).toString('base64url');
    const { code } = await signIn({
      clientId: mobile.clientId,
      redirectUri: MOBILE_REDIRECT,
      scope: options.scope,
      nonce,
      codeChallenge: challenge,
    });
    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: MOBILE_REDIRECT,
      client_id: mobile.clientId,
      code_verifier: verifier,
    });
    return { body: await expectTokenBody(res), verifier, nonce };
  };

  const confidentialFlow = async (
    secret: string,
    method: 'post' | 'basic' = 'post',
  ): Promise<{ res: Response; code: string }> => {
    const { code } = await signIn({ clientId: zotac.clientId, redirectUri: ZOTAC_REDIRECT });
    const res =
      method === 'basic'
        ? await exchange(
            { grant_type: 'authorization_code', code, redirect_uri: ZOTAC_REDIRECT },
            { authorization: basicAuth(zotac.clientId, secret) },
          )
        : await exchange({
            grant_type: 'authorization_code',
            code,
            redirect_uri: ZOTAC_REDIRECT,
            client_id: zotac.clientId,
            client_secret: secret,
          });
    return { res, code };
  };

  const auditEvents = async (): Promise<AuditEventView[]> => {
    const res = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: AuditEventView[] }).events;
  };

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);

    const ceremony = await instance.request('/api/setup', {
      method: 'POST',
      query: { token: instance.setupToken() },
      body: { organizationName: ORGANIZATION_NAME, ...OWNER },
    });
    expect(ceremony.status).toBe(201);

    const owner = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(owner.status).toBe(200);
    ownerCookie = cookieFrom(owner);

    zotac = await registerApplication('Zotac', 'web', ZOTAC_REDIRECT);
    mobile = await registerApplication('Mobile', 'spa', MOBILE_REDIRECT);

    await signUpAndVerify(END_USER);
  });

  afterAll(async () => {
    await instance.stop();
  });

  describe('discovery and JWKS', () => {
    it('discovery self-describes every endpoint and capability', async () => {
      const doc = await instance.getJson<Record<string, unknown>>(
        '/.well-known/openid-configuration',
      );
      expect(doc).toMatchObject({
        issuer: instance.url,
        authorization_endpoint: `${instance.url}/api/oidc/authorize`,
        token_endpoint: `${instance.url}/api/oidc/token`,
        userinfo_endpoint: `${instance.url}/api/oidc/userinfo`,
        jwks_uri: `${instance.url}/api/oidc/jwks`,
        revocation_endpoint: `${instance.url}/api/oidc/revoke`,
        introspection_endpoint: `${instance.url}/api/oidc/introspect`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
      expect(doc.grant_types_supported).toEqual(
        expect.arrayContaining(['authorization_code', 'refresh_token']),
      );
      expect(doc.scopes_supported).toEqual(
        expect.arrayContaining(['openid', 'email', 'profile']),
      );
    });

    it('JWKS publishes the verification key and issued JWTs verify offline over HTTP only', async () => {
      const { body } = await publicFlow();

      const jwksDocument = await instance.getJson<{ keys: Array<Record<string, unknown>> }>(
        '/api/oidc/jwks',
      );
      expect(jwksDocument.keys.length).toBeGreaterThan(0);
      expect(jwksDocument.keys[0]).toMatchObject({
        kty: 'RSA',
        use: 'sig',
        alg: 'RS256',
      });
      expect(jwksDocument.keys[0]!.kid).toBeTruthy();

      // The whole point of JWKS: verification happens locally against keys
      // fetched over HTTP, with no call back into the platform.
      const jwks = createRemoteJWKSet(new URL(`${instance.url}/api/oidc/jwks`));
      const access = await jwtVerify(body.access_token, jwks, {
        issuer: instance.url,
        audience: instance.url,
        typ: 'at+jwt',
      });
      expect(access.payload.client_id).toBe(mobile.clientId);
      expect(access.payload.scope).toBe('openid email profile');
      expect(access.payload.aud).toBe(instance.url);
      expect(access.payload.exp! - access.payload.iat!).toBeLessThanOrEqual(15 * 60);

      const id = await jwtVerify(body.id_token, jwks, {
        issuer: instance.url,
        audience: mobile.clientId,
      });
      expect(id.payload.sub).toBe(access.payload.sub);
    });

    it('the access token audience is the platform, never the client Application', async () => {
      const { body } = await publicFlow();
      const jwks = createRemoteJWKSet(new URL(`${instance.url}/api/oidc/jwks`));
      const access = await jwtVerify(body.access_token, jwks, { issuer: instance.url });
      expect(access.payload.aud).toBe(instance.url);
      expect(access.payload.aud).not.toBe(mobile.clientId);
      expect(access.payload.exp! - access.payload.iat!).toBeLessThanOrEqual(15 * 60);
    });

    it('the ID token asserts identity, email + verification state, audience, and timestamps', async () => {
      const nonce = randomBytes(8).toString('base64url');
      const { body } = await publicFlow({ nonce });
      const claims = decodeJwt(body.id_token);
      expect(claims.iss).toBe(instance.url);
      expect(claims.aud).toBe(mobile.clientId);
      expect(claims.sub).toBeTruthy();
      expect(claims.email).toBe(END_USER.email);
      expect(claims.email_verified).toBe(true);
      expect(claims.nonce).toBe(nonce);
      expect(typeof claims.auth_time).toBe('number');
      expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(15 * 60);
      expect(body.expires_in).toBeLessThanOrEqual(15 * 60);
    });
  });

  describe('confidential client authentication', () => {
    it('a confidential client authenticates with any of its concurrent secrets', async () => {
      const first = await confidentialFlow(zotac.secret);
      expect(first.res.status).toBe(200);
      await expectTokenBody(first.res);

      const issued = await instance.request(`/api/applications/${zotac.id}/secrets`, {
        method: 'POST',
        headers: { cookie: ownerCookie },
        body: { label: 'rotation' },
      });
      expect(issued.status).toBe(201);
      const issuedBody = (await issued.json()) as {
        secret: { id: string };
        clientSecret: string;
      };

      const second = await confidentialFlow(issuedBody.clientSecret);
      await expectTokenBody(second.res);

      const basic = await confidentialFlow(issuedBody.clientSecret, 'basic');
      await expectTokenBody(basic.res);

      // Revoking one concurrent secret kills exactly that credential, with no
      // effect on its siblings and no downtime for the Application.
      const revoked = await instance.request(
        `/api/applications/${zotac.id}/secrets/${issuedBody.secret.id}/revoke`,
        { method: 'POST', headers: { cookie: ownerCookie } },
      );
      expect(revoked.status).toBe(200);

      const dead = await confidentialFlow(issuedBody.clientSecret);
      expect(dead.res.status).toBe(401);
      expect(((await dead.res.json()) as { error: string }).error).toBe('invalid_client');

      const survivor = await confidentialFlow(zotac.secret);
      await expectTokenBody(survivor.res);
    });

    it('misused or absent secrets fail exchange immediately', async () => {
      const { code } = await signIn({ clientId: zotac.clientId, redirectUri: ZOTAC_REDIRECT });
      const base = { grant_type: 'authorization_code', code, redirect_uri: ZOTAC_REDIRECT };

      const wrong = await exchange({
        ...base,
        client_id: zotac.clientId,
        client_secret: 'not-the-secret',
      });
      expect(wrong.status).toBe(401);
      expect(((await wrong.json()) as { error: string }).error).toBe('invalid_client');

      const absent = await exchange({ ...base, client_id: zotac.clientId });
      expect(absent.status).toBe(401);

      const unknownClient = await exchange({
        ...base,
        client_id: 'no-such-client',
        client_secret: zotac.secret,
      });
      expect(unknownClient.status).toBe(401);
      expect(((await unknownClient.json()) as { error: string }).error).toBe('invalid_client');

      // RFC 6749 §5.2: header-based authentication failures challenge back.
      const { code: basicCode } = await signIn({
        clientId: zotac.clientId,
        redirectUri: ZOTAC_REDIRECT,
      });
      const basicWrong = await exchange(
        { grant_type: 'authorization_code', code: basicCode, redirect_uri: ZOTAC_REDIRECT },
        { authorization: basicAuth(zotac.clientId, 'not-the-secret') },
      );
      expect(basicWrong.status).toBe(401);
      expect(basicWrong.headers.get('www-authenticate')).toContain('Basic');

      // Scheme names are case-insensitive (RFC 7235 §2.1).
      const { code: lowerCode } = await signIn({
        clientId: zotac.clientId,
        redirectUri: ZOTAC_REDIRECT,
      });
      const lowercase = await exchange(
        { grant_type: 'authorization_code', code: lowerCode, redirect_uri: ZOTAC_REDIRECT },
        { authorization: basicAuth(zotac.clientId, zotac.secret).replace(/^Basic/, 'basic') },
      );
      await expectTokenBody(lowercase);
    });

    it('a confidential client may exchange without PKCE — its secret replaces it', async () => {
      const { res } = await confidentialFlow(zotac.secret);
      await expectTokenBody(res);
    });
  });

  describe('public client authentication and PKCE', () => {
    it('no Client Secret is ever accepted from a public client', async () => {
      const { verifier, challenge } = pkce();
      const { code } = await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        codeChallenge: challenge,
      });

      const bodySecret = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: MOBILE_REDIRECT,
        client_id: mobile.clientId,
        code_verifier: verifier,
        client_secret: 'a-leaked-secret',
      });
      expect(bodySecret.status).toBe(401);
      expect(((await bodySecret.json()) as { error: string }).error).toBe('invalid_client');

      const { code: secondCode } = await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        codeChallenge: challenge,
      });
      const basic = await exchange(
        {
          grant_type: 'authorization_code',
          code: secondCode,
          redirect_uri: MOBILE_REDIRECT,
          code_verifier: verifier,
        },
        { authorization: basicAuth(mobile.clientId, 'a-leaked-secret') },
      );
      expect(basic.status).toBe(401);
    });

    it('a public client must present a valid PKCE verifier, and a failed attempt burns the code', async () => {
      const { verifier, challenge } = pkce();
      const { code } = await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        codeChallenge: challenge,
      });

      const missing = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: MOBILE_REDIRECT,
        client_id: mobile.clientId,
      });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe('invalid_request');

      const retry = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: MOBILE_REDIRECT,
        client_id: mobile.clientId,
        code_verifier: verifier,
      });
      expect(retry.status).toBe(400);
      expect(((await retry.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('a wrong PKCE verifier is refused', async () => {
      const { challenge } = pkce();
      const { code } = await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        codeChallenge: challenge,
      });
      const res = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: MOBILE_REDIRECT,
        client_id: mobile.clientId,
        code_verifier: randomBytes(32).toString('base64url'),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('PKCE presented by a confidential client is verified on exchange too', async () => {
      const wrongAttempt = pkce();
      const wrongSignIn = await signIn({
        clientId: zotac.clientId,
        redirectUri: ZOTAC_REDIRECT,
        codeChallenge: wrongAttempt.challenge,
      });
      const wrong = await exchange({
        grant_type: 'authorization_code',
        code: wrongSignIn.code,
        redirect_uri: ZOTAC_REDIRECT,
        client_id: zotac.clientId,
        client_secret: zotac.secret,
        code_verifier: randomBytes(32).toString('base64url'),
      });
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant');

      const goodAttempt = pkce();
      const goodSignIn = await signIn({
        clientId: zotac.clientId,
        redirectUri: ZOTAC_REDIRECT,
        codeChallenge: goodAttempt.challenge,
      });
      const good = await exchange({
        grant_type: 'authorization_code',
        code: goodSignIn.code,
        redirect_uri: ZOTAC_REDIRECT,
        client_id: zotac.clientId,
        client_secret: zotac.secret,
        code_verifier: goodAttempt.verifier,
      });
      await expectTokenBody(good);
    });

    it('a public client with an openid-only scope receives only the subject', async () => {
      const { body } = await publicFlow({ scope: 'openid' });
      const claims = decodeJwt(body.id_token);
      expect(claims.sub).toBeTruthy();
      expect(claims.email).toBeUndefined();

      const res = await instance.request('/api/oidc/userinfo', {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(res.status).toBe(200);
      const profile = (await res.json()) as Record<string, unknown>;
      expect(profile).toEqual({ sub: claims.sub });
    });
  });

  describe('authorization code exchange', () => {
    it('a code exchanges exactly once; replay is refused', async () => {
      const { verifier, challenge } = pkce();
      const { code } = await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        codeChallenge: challenge,
      });
      const form = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: MOBILE_REDIRECT,
        client_id: mobile.clientId,
        code_verifier: verifier,
      };
      await expectTokenBody(await exchange(form));

      const replay = await exchange(form);
      expect(replay.status).toBe(400);
      expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('the redirect_uri bound to the code is enforced', async () => {
      const { verifier, challenge } = pkce();
      const { code } = await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        codeChallenge: challenge,
      });
      const res = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://evil.example.com/callback',
        client_id: mobile.clientId,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('an unsupported grant type is refused', async () => {
      const res = await exchange({ grant_type: 'client_credentials', client_id: mobile.clientId });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
    });
  });

  describe('rotating refresh tokens, children of the Session', () => {
    it('refresh tokens rotate on use; a spent token is refused and kills the lineage', async () => {
      const { body } = await publicFlow();

      const first = await exchange({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: mobile.clientId,
      });
      const rotated = await expectTokenBody(first);
      expect(rotated.refresh_token).not.toBe(body.refresh_token);
      expect(rotated.access_token).not.toBe(body.access_token);

      const replay = await exchange({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: mobile.clientId,
      });
      expect(replay.status).toBe(400);
      expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');

      // Reuse is the theft signal: the whole lineage is revoked.
      const lineage = await exchange({
        grant_type: 'refresh_token',
        refresh_token: rotated.refresh_token,
        client_id: mobile.clientId,
      });
      expect(lineage.status).toBe(400);
      expect(((await lineage.json()) as { error: string }).error).toBe('invalid_grant');

      const reuse = (await auditEvents()).filter(
        (event) => event.kind === 'refresh_token.reuse.detected',
      );
      expect(reuse.length).toBeGreaterThan(0);
    });

    it('a refresh may narrow its scopes, never widen them', async () => {
      const { body } = await publicFlow();

      const widened = await exchange({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: mobile.clientId,
        scope: 'openid email profile admin',
      });
      expect(widened.status).toBe(400);
      expect(((await widened.json()) as { error: string }).error).toBe('invalid_scope');

      const narrowed = await exchange({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: mobile.clientId,
        scope: 'openid email',
      });
      const rotated = await expectTokenBody(narrowed);
      expect(rotated.scope).toBe('openid email');
      expect(decodeJwt(rotated.id_token).email).toBe(END_USER.email);
      expect(decodeJwt(rotated.id_token).preferred_username).toBeUndefined();
    });

    it('a refresh token is bound to the client it was issued to', async () => {
      const { body } = await publicFlow();
      const res = await exchange({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: zotac.clientId,
        client_secret: zotac.secret,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('a refresh token dies with the Session whose authentication minted it', async () => {
      await signUpAndVerify(HEALED);
      const { verifier, challenge } = pkce();
      const { code } = await signIn({
        clientId: mobile.clientId,
        redirectUri: MOBILE_REDIRECT,
        codeChallenge: challenge,
        email: HEALED.email,
        password: HEALED.password,
      });
      const tokens = await expectTokenBody(
        await exchange({
          grant_type: 'authorization_code',
          code,
          redirect_uri: MOBILE_REDIRECT,
          client_id: mobile.clientId,
          code_verifier: verifier,
        }),
      );
      const refreshed = await expectTokenBody(
        await exchange({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: mobile.clientId,
        }),
      );

      // A password reset proves mailbox control and revokes every Session
      // created before it (ticket 04) — the parent of this lineage dies.
      const requested = await instance.request('/api/end-users/forgot-password', {
        method: 'POST',
        body: { email: HEALED.email },
      });
      expect(requested.status).toBe(202);
      const mail = (await instance.capturedEmails())
        .filter((entry) => entry.to === HEALED.email && /reset/i.test(entry.subject))
        .at(-1);
      if (!mail) throw new Error('no reset mail');
      const resetToken = new URL(linkFromBody(mail.body)).searchParams.get('token')!;
      const reset = await instance.request('/api/end-users/reset-password', {
        method: 'POST',
        body: { token: resetToken, password: 'healed password 456' },
      });
      expect(reset.status).toBe(200);

      const dead = await exchange({
        grant_type: 'refresh_token',
        refresh_token: refreshed.refresh_token,
        client_id: mobile.clientId,
      });
      expect(dead.status).toBe(400);
      expect(((await dead.json()) as { error: string }).error).toBe('invalid_grant');
    });
  });

  describe('userinfo', () => {
    it('serves claims for a valid access token over both GET and POST', async () => {
      const { body } = await publicFlow();
      const res = await instance.request('/api/oidc/userinfo', {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const claims = (await res.json()) as Record<string, unknown>;
      expect(claims).toMatchObject({
        email: END_USER.email,
        email_verified: true,
        preferred_username: END_USER.email,
      });
      expect(typeof claims.sub).toBe('string');

      // OIDC Core §5.3.1: the endpoint must support POST too.
      const posted = await instance.request('/api/oidc/userinfo', {
        method: 'POST',
        form: { access_token: body.access_token },
      });
      expect(posted.status).toBe(200);
      expect(await posted.json()).toEqual(claims);
    });

    it('refuses missing, malformed, and ID tokens', async () => {
      const noToken = await instance.request('/api/oidc/userinfo');
      expect(noToken.status).toBe(401);
      expect(noToken.headers.get('www-authenticate')).toContain('Bearer');

      const garbage = await instance.request('/api/oidc/userinfo', {
        headers: { authorization: 'Bearer not-a-token' },
      });
      expect(garbage.status).toBe(401);

      // An ID token is an assertion about the person, not a credential for
      // the platform's endpoints: the `typ` header keeps them apart.
      const { body } = await publicFlow();
      const idTokenAsBearer = await instance.request('/api/oidc/userinfo', {
        headers: { authorization: `Bearer ${body.id_token}` },
      });
      expect(idTokenAsBearer.status).toBe(401);
    });
  });

  describe('introspection and revocation', () => {
    const introspect = (
      form: Record<string, string>,
      headers?: Record<string, string>,
    ): Promise<Response> =>
      instance.request('/api/oidc/introspect', {
        method: 'POST',
        form,
        headers,
        redirect: 'manual',
      });

    const revoke = (
      form: Record<string, string>,
      headers?: Record<string, string>,
    ): Promise<Response> =>
      instance.request('/api/oidc/revoke', {
        method: 'POST',
        form,
        headers,
        redirect: 'manual',
      });

    it('answers active for a live access token and a live refresh token', async () => {
      const { body } = await publicFlow();

      const accessVerdict = await introspect({
        token: body.access_token,
        client_id: mobile.clientId,
      });
      expect(accessVerdict.status).toBe(200);
      expect(await accessVerdict.json()).toMatchObject({
        active: true,
        client_id: mobile.clientId,
        scope: 'openid email profile',
        token_type: 'Bearer',
      });

      const refreshVerdict = await introspect({
        token: body.refresh_token,
        client_id: mobile.clientId,
      });
      expect(refreshVerdict.status).toBe(200);
      const refresh = (await refreshVerdict.json()) as Record<string, unknown>;
      expect(refresh).toMatchObject({
        active: true,
        client_id: mobile.clientId,
        token_type: 'refresh_token',
        iss: instance.url,
        aud: instance.url,
      });
      expect(refresh.sub).toBeTruthy();
      expect(refresh.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('requires the token parameter (RFC 7009, RFC 7662)', async () => {
      const revokeMissing = await revoke({ client_id: mobile.clientId });
      expect(revokeMissing.status).toBe(400);
      expect(((await revokeMissing.json()) as { error: string }).error).toBe('invalid_request');

      const introspectMissing = await introspect({ client_id: mobile.clientId });
      expect(introspectMissing.status).toBe(400);
      expect(((await introspectMissing.json()) as { error: string }).error).toBe(
        'invalid_request',
      );
    });

    it('answers active=false for unknown tokens and for another client\u2019s tokens', async () => {
      const unknown = await introspect({
        token: randomBytes(16).toString('base64url'),
        client_id: mobile.clientId,
      });
      expect(await unknown.json()).toEqual({ active: false });

      const { body } = await publicFlow();
      const foreign = await introspect(
        { token: body.refresh_token },
        { authorization: basicAuth(zotac.clientId, zotac.secret) },
      );
      expect(await foreign.json()).toEqual({ active: false });
    });

    it('revokes a refresh token so it can no longer rotate', async () => {
      const { body } = await publicFlow();
      const revoked = await revoke({
        token: body.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: mobile.clientId,
      });
      expect(revoked.status).toBe(200);

      const verdict = await introspect({
        token: body.refresh_token,
        client_id: mobile.clientId,
      });
      expect(await verdict.json()).toEqual({ active: false });

      const rotate = await exchange({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: mobile.clientId,
      });
      expect(rotate.status).toBe(400);
      expect(((await rotate.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('revocation answers uniformly, and access tokens stay untracked', async () => {
      const { body } = await publicFlow();

      // Access tokens are deliberately untracked (ADR-0013): revocation is a
      // no-op and the token stays valid until its short TTL.
      const revokedAccess = await revoke({
        token: body.access_token,
        client_id: mobile.clientId,
      });
      expect(revokedAccess.status).toBe(200);
      const userinfo = await instance.request('/api/oidc/userinfo', {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(userinfo.status).toBe(200);

      const unknown = await revoke({
        token: randomBytes(16).toString('base64url'),
        client_id: mobile.clientId,
      });
      expect(unknown.status).toBe(200);
    });
  });

  describe('a stock OIDC client library (the zero-SDK assertion)', () => {
    it('completes the full code + PKCE flow with no proprietary code', async () => {
      const config = await client.discovery(
        new URL(instance.url),
        mobile.clientId,
        undefined,
        client.None(),
        { execute: [client.allowInsecureRequests] },
      );
      const verifier = client.randomPKCECodeVerifier();
      const challenge = await client.calculatePKCECodeChallenge(verifier);
      const state = client.randomState();
      const nonce = client.randomNonce();

      const authorizationUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: MOBILE_REDIRECT,
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });

      const signedIn = await instance.request(
        `${authorizationUrl.pathname}${authorizationUrl.search}`,
        {
          method: 'POST',
          redirect: 'manual',
          body: { email: END_USER.email, password: END_USER.password },
        },
      );
      if (signedIn.status !== 302) {
        throw new Error(`sign-in failed: ${signedIn.status} ${await signedIn.text()}`);
      }
      const currentUrl = new URL(signedIn.headers.get('location')!);

      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
      });
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();

      const idClaims = tokens.claims();
      expect(idClaims?.sub).toBeTruthy();
      expect(idClaims?.email).toBe(END_USER.email);
      expect(idClaims?.email_verified).toBe(true);
      expect(idClaims?.nonce).toBe(nonce);

      const userinfo = (await client.fetchUserInfo(
        config,
        tokens.access_token,
        idClaims!.sub!,
      )) as unknown as Record<string, unknown>;
      expect(userinfo).toMatchObject({ email: END_USER.email, email_verified: true });

      const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token!);
      expect(refreshed.access_token).toBeTruthy();
      expect(refreshed.refresh_token).toBeTruthy();

      await client.tokenRevocation(config, refreshed.refresh_token!, {
        token_type_hint: 'refresh_token',
      });
      await expect(client.refreshTokenGrant(config, refreshed.refresh_token!)).rejects.toThrow();

      const verdict = await client.tokenIntrospection(config, tokens.access_token);
      expect(verdict.active).toBe(true);
    });

    it('lets a confidential client discover, exchange with its secret, and introspect', async () => {
      const config = await client.discovery(
        new URL(instance.url),
        zotac.clientId,
        zotac.secret,
        undefined,
        { execute: [client.allowInsecureRequests] },
      );
      const verifier = client.randomPKCECodeVerifier();
      const challenge = await client.calculatePKCECodeChallenge(verifier);
      const state = client.randomState();

      const authorizationUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: ZOTAC_REDIRECT,
        scope: 'openid email',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });
      const signedIn = await instance.request(
        `${authorizationUrl.pathname}${authorizationUrl.search}`,
        {
          method: 'POST',
          redirect: 'manual',
          body: { email: END_USER.email, password: END_USER.password },
        },
      );
      if (signedIn.status !== 302) {
        throw new Error(`sign-in failed: ${signedIn.status} ${await signedIn.text()}`);
      }
      const tokens = await client.authorizationCodeGrant(
        config,
        new URL(signedIn.headers.get('location')!),
        { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: undefined },
      );
      expect(tokens.access_token).toBeTruthy();

      const verdict = await client.tokenIntrospection(config, tokens.access_token);
      expect(verdict).toMatchObject({ active: true, client_id: zotac.clientId });
    });
  });
});
