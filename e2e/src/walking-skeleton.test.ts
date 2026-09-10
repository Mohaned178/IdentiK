import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

/**
 * Ticket 01 — walking skeleton. These tests are the repository's testing
 * pattern made real: black-box conversations with a live Instance through
 * Seam 1 (HTTP surface) and Seam 2 (captured email) only.
 */
describe('Instance walking skeleton', () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await Instance.start(backendDistFromWorkspaceRoot(WORKSPACE_ROOT));
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

  it('exposes nothing else yet (unknown routes are 404, not 500)', async () => {
    const res = await instance.request('/definitely-not-a-route');
    expect(res.status).toBe(404);
  });

  describe('Seam 2 — captured outbound email', () => {
    it('starts with an empty capture', async () => {
      const emails = await instance.capturedEmails();
      expect(emails).toEqual([]);
    });

    it('captures a sent email with recipient, subject, and body', async () => {
      const res = await instance.request('/dev/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'mohamed@example.com',
          subject: 'Verify your email',
          body: 'Welcome to Zotac. Click: https://example.test/verify?token=abc',
        }),
      });
      expect(res.status).toBe(201);

      const emails = await instance.capturedEmails();
      const sent = emails.find((e) => e.to === 'mohamed@example.com');
      expect(sent?.subject).toBe('Verify your email');
      expect(sent?.body).toContain('https://example.test/verify?token=abc');
    });
  });

  describe('instance-per-run isolation', () => {
    it('has no memory of a previous Instance (fresh state, fresh capture)', async () => {
      const first = instance;
      const second = await Instance.start(backendDistFromWorkspaceRoot(WORKSPACE_ROOT));
      try {
        const emails = await second.capturedEmails();
        expect(emails).toEqual([]);
        const health = await second.getJson<{ status: string }>('/health');
        expect(health.status).toBe('ok');
        // The two Instances are distinct and independent.
        expect(second.url).not.toBe(first.url);
      } finally {
        await second.stop();
      }
    });
  });
});
