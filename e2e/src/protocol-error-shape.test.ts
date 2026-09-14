import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Protocol error shape: the unauthenticated OIDC surfaces answer malformed
 * requests with protocol errors, never a 500. An empty body (no JSON, no
 * form) is the degenerate case — a client that POSTs only headers, or
 * nothing at all, still gets `invalid_client` / `invalid_token`, the same
 * verdict a bad credential earns.
 */
describe('Protocol error shape on empty bodies', () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('the token surface refuses an empty body as an unauthenticated client', async () => {
    for (const path of ['/api/oidc/token', '/api/oidc/introspect', '/api/oidc/revoke']) {
      const res = await instance.request(path, { method: 'POST' });
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { error: string }).error, path).toBe('invalid_client');
    }
  });

  it('userinfo refuses an empty body, including a header-only POST', async () => {
    const empty = await instance.request('/api/oidc/userinfo', { method: 'POST' });
    expect(empty.status).toBe(401);
    expect(((await empty.json()) as { error: string }).error).toBe('invalid_token');

    const headerOnly = await instance.request('/api/oidc/userinfo', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(headerOnly.status).toBe(401);
    expect(((await headerOnly.json()) as { error: string }).error).toBe('invalid_token');
  });
});
