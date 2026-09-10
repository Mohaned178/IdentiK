import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 01 — walking skeleton. These tests are the repository's testing
 * pattern made real: black-box conversations with a live Instance through
 * Seam 1 (HTTP surface) and Seam 2 (captured email) only.
 */
describe('Instance walking skeleton', () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST);
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('boots and reports health over HTTP', async () => {
    const res = await instance.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('unknown routes are 404 — API and non-API alike (no SPA shell)', async () => {
    const api = await instance.request('/api/definitely-not-a-route');
    expect(api.status).toBe(404);
    const nonApi = await instance.request('/definitely-not-a-page');
    expect(nonApi.status).toBe(404);
  });

  describe('Seam 2 — captured outbound email', () => {
    it('captures a sent email with recipient, subject, and body', async () => {
      const res = await instance.request('/dev/mail', {
        method: 'POST',
        body: {
          to: 'mohamed@example.com',
          subject: 'Verify your email',
          body: 'Welcome to Zotac. Click: https://example.test/verify?token=abc',
        },
      });
      expect(res.status).toBe(201);

      const emails = await instance.capturedEmails();
      const sent = emails.find((e) => e.to === 'mohamed@example.com');
      expect(sent?.subject).toBe('Verify your email');
      expect(sent?.body).toContain('https://example.test/verify?token=abc');
    });
  });

  describe('instance-per-run isolation', () => {
    it('a fresh Instance has an empty capture, unaffected by another Instance sending mail', async () => {
      const first = instance;
      await first.request('/dev/mail', {
        method: 'POST',
        body: { to: 'sara@example.com', subject: 'first', body: 'from the first instance' },
      });

      const second = await Instance.start(BACKEND_DIST);
      try {
        const emails = await second.capturedEmails();
        expect(emails).toEqual([]);
        expect(second.url).not.toBe(first.url);
      } finally {
        await second.stop();
      }
    });
  });
});
