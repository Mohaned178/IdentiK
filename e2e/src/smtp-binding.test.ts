import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { simpleParser, type ParsedMail } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import {
  backendDistFromWorkspaceRoot,
  freePort,
  Instance,
  WORKSPACE_ROOT,
} from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 20 — Production SMTP transport binding (ADR-0022). The outbound mail
 * boundary is deployment configuration: with `MAIL_TRANSPORT_BINDING=smtp` the
 * Instance delivers every platform mail through the Operator's relay, with
 * connection details that are never addressable from the dashboard or
 * Management API. The capture binding stays the test binding — selected by the
 * same configuration, with no caller changes — and a misconfigured relay is
 * diagnosable from startup and health without leaking the credential. The
 * relay here is a local SMTP sink over Seam 2's wire format; everything else
 * is Seam 1 (HTTP) only.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER_EMAIL = 'layla@example.com';
const END_USER = { email: 'mohamed@example.com', password: 'end user password 123' };
const END_USER_NEW_EMAIL = 'mohamed.new@example.com';
const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';

const RELAY_USER = 'identik-relay';
const RELAY_PASSWORD = 'relay-secret-71ac93e2';
const MAIL_FROM = 'IdentiK <no-reply@identik.test>';

interface MailHealth {
  binding: string;
  reachable: boolean;
}

interface HealthView {
  status: string;
  mail: MailHealth;
}

/** A local SMTP relay that records the mail the Instance hands it. */
class SmtpSink {
  private constructor(
    private readonly server: SMTPServer,
    readonly port: number,
    private readonly received: ParsedMail[],
    private readonly authenticatedUsers: string[],
  ) {}

  static async start(): Promise<SmtpSink> {
    const received: ParsedMail[] = [];
    const authenticatedUsers: string[] = [];
    const server = new SMTPServer({
      // The sink is cleartext on loopback; the transport is told not to require TLS.
      hideSTARTTLS: true,
      onAuth(auth, _session, callback) {
        if (auth.username === RELAY_USER && auth.password === RELAY_PASSWORD) {
          authenticatedUsers.push(auth.username);
          callback(null, { user: auth.username });
          return;
        }
        callback(new Error('invalid relay credentials'));
      },
      onData(stream, _session, callback) {
        simpleParser(stream)
          .then((parsed) => {
            received.push(parsed);
            callback();
          })
          .catch((error: unknown) => callback(error as Error));
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.server.address() as AddressInfo).port;
    return new SmtpSink(server, port, received, authenticatedUsers);
  }

  authenticated(): string[] {
    return [...this.authenticatedUsers];
  }

  async waitFor(
    predicate: (mail: ParsedMail) => boolean,
    timeoutMs = 10_000,
  ): Promise<ParsedMail> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.received.find(predicate);
      if (found) return found;
      await sleep(100);
    }
    throw new Error('no matching mail arrived at the SMTP sink within the deadline');
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function recipient(mail: ParsedMail): string | undefined {
  const to = Array.isArray(mail.to) ? mail.to[0] : mail.to;
  return to?.value[0]?.address;
}

function linkFromText(text: string | undefined): string {
  const match = (text ?? '').match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in delivered mail');
  return match[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function health(instance: Instance): Promise<HealthView> {
  const res = await instance.request('/health');
  expect(res.status).toBe(200);
  return (await res.json()) as HealthView;
}

async function waitForMailHealth(
  instance: Instance,
  predicate: (mail: MailHealth) => boolean,
  timeoutMs = 20_000,
): Promise<HealthView> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthView | undefined;
  while (Date.now() < deadline) {
    last = await health(instance);
    if (predicate(last.mail)) return last;
    await sleep(250);
  }
  throw new Error(`mail health never matched; last seen: ${JSON.stringify(last)}`);
}

async function waitForOutput(
  instance: Instance,
  predicate: (output: string) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(instance.consoleLog())) return;
    await sleep(250);
  }
  throw new Error('expected diagnostic never appeared in the Instance output');
}

function setupToken(instance: Instance): string {
  const match = [...instance.consoleLog().matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1);
  if (!match) throw new Error('no setup token in console output');
  return match[1]!;
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** Register a Web Application so an End User can obtain a Session and reach the Account Center. */
async function registerApplication(instance: Instance, ownerCookie: string): Promise<string> {
  const registered = await instance.request('/api/applications', {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: { name: 'Zotac', type: 'web' },
  });
  expect(registered.status).toBe(201);
  const { application } = (await registered.json()) as {
    application: { id: string; clientId: string };
  };
  const added = await instance.request(`/api/applications/${application.id}/redirect-uris`, {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: { uri: ZOTAC_REDIRECT },
  });
  expect(added.status).toBe(201);
  return application.clientId;
}

describe('SMTP transport binding delivers platform mail', () => {
  let instance: Instance;
  let sink: SmtpSink;
  let ownerCookie: string;

  beforeAll(async () => {
    sink = await SmtpSink.start();
    instance = await Instance.start(BACKEND_DIST, {
      MAIL_TRANSPORT_BINDING: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(sink.port),
      SMTP_USER: RELAY_USER,
      SMTP_PASSWORD: RELAY_PASSWORD,
      SMTP_REQUIRE_TLS: 'false',
      MAIL_FROM,
    });

    const ceremony = await instance.request('/api/setup', {
      method: 'POST',
      query: { token: setupToken(instance) },
      body: { organizationName: ORGANIZATION_NAME, ...OWNER },
    });
    expect(ceremony.status).toBe(201);

    const signIn = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(signIn.status).toBe(200);
    ownerCookie = cookieFrom(signIn);
  });

  afterAll(async () => {
    await instance?.stop();
    await sink?.stop();
  });

  it('health names the SMTP binding and reports the relay reachable, exposing no infrastructure detail', async () => {
    const view = await health(instance);
    expect(view.status).toBe('ok');
    expect(view.mail).toEqual({ binding: 'smtp', reachable: true });
    expect(JSON.stringify(view)).not.toContain(RELAY_PASSWORD);
    expect(JSON.stringify(view)).not.toContain(`127.0.0.1:${sink.port}`);
  });

  it('mounts no capture surface when the SMTP binding is selected', async () => {
    expect((await instance.request('/dev/mail')).status).toBe(404);
  });

  it('delivers invitation mail through the configured relay, authenticated as configured', async () => {
    const issued = await instance.request('/api/administrators/invitations', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { email: MEMBER_EMAIL, role: 'member' },
    });
    expect(issued.status).toBe(201);

    const mail = await sink.waitFor((candidate) => recipient(candidate) === MEMBER_EMAIL);
    expect(mail.from?.value[0]?.address).toBe('no-reply@identik.test');
    expect(mail.subject).toContain(`invited to administer ${ORGANIZATION_NAME}`);
    expect(mail.text).toContain('/administrators/accept-invitation?token=');
    expect(sink.authenticated()).toContain(RELAY_USER);
  });

  it('delivers the sign-up verification link through the relay, and the link still works', async () => {
    const signUp = await instance.request('/api/end-users/sign-up', {
      method: 'POST',
      body: END_USER,
    });
    expect(signUp.status).toBe(201);

    const mail = await sink.waitFor(
      (candidate) =>
        recipient(candidate) === END_USER.email && /verify/i.test(candidate.subject ?? ''),
    );
    expect(mail.subject).toContain(`Verify your email — ${ORGANIZATION_NAME}`);

    const click = await fetch(linkFromText(mail.text), { redirect: 'manual' });
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toContain('outcome=verified');
  });

  it('delivers password-reset mail through the relay', async () => {
    const forgot = await instance.request('/api/end-users/forgot-password', {
      method: 'POST',
      body: { email: END_USER.email },
    });
    expect(forgot.status).toBe(202);

    const mail = await sink.waitFor(
      (candidate) =>
        recipient(candidate) === END_USER.email && /reset/i.test(candidate.subject ?? ''),
    );
    expect(mail.text).toContain('/end-users/reset-password?token=');
  });

  it('delivers email-change verification to the new address through the relay, and the change completes', async () => {
    const clientId = await registerApplication(instance, ownerCookie);
    const signIn = await instance.request('/api/oidc/authorize', {
      method: 'POST',
      redirect: 'manual',
      query: {
        client_id: clientId,
        redirect_uri: ZOTAC_REDIRECT,
        response_type: 'code',
        scope: 'openid email',
        state: 'email-change',
      },
      body: { email: END_USER.email, password: END_USER.password },
    });
    expect(signIn.status).toBe(302);
    const endUserCookie = cookieFrom(signIn);

    const requested = await instance.request('/api/account-center/email', {
      method: 'POST',
      headers: { cookie: endUserCookie },
      body: { newEmail: END_USER_NEW_EMAIL },
    });
    expect(requested.status).toBe(202);

    const mail = await sink.waitFor(
      (candidate) => recipient(candidate) === END_USER_NEW_EMAIL,
    );
    expect(mail.subject).toContain('Confirm your new email');

    const click = await fetch(linkFromText(mail.text), { redirect: 'manual' });
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toContain('outcome=changed');
  });

  it('leaks no relay credential into the Instance output', () => {
    expect(instance.consoleLog()).not.toContain(RELAY_PASSWORD);
    expect(instance.consoleLog()).not.toContain(RELAY_USER);
  });

  it('exposes only Organization-scoped settings through the Management API', async () => {
    const res = await instance.request('/api/organization/settings', {
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual([
      'branding',
      'passwordPolicy',
      'sessionPolicy',
    ]);
    expect(raw).not.toContain(RELAY_PASSWORD);
    expect(raw).not.toContain('127.0.0.1');

    const refused = await instance.request('/api/organization/settings', {
      method: 'PUT',
      headers: { cookie: ownerCookie },
      body: { smtp: { host: 'mail.evil.example' } },
    });
    expect(refused.status).toBe(400);
  });
});

describe('misconfigured SMTP relay is diagnosable without leaking secrets', () => {
  let instance: Instance;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    instance = await Instance.start(BACKEND_DIST, {
      MAIL_TRANSPORT_BINDING: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_USER: RELAY_USER,
      SMTP_PASSWORD: RELAY_PASSWORD,
      SMTP_REQUIRE_TLS: 'false',
      MAIL_FROM,
    });
  });

  afterAll(async () => {
    await instance?.stop();
  });

  it('health reports the unreachable relay as degraded, exposing neither endpoint nor credential', async () => {
    const view = await waitForMailHealth(instance, (mail) => !mail.reachable);
    expect(view.status).toBe('degraded');
    expect(view.mail).toEqual({ binding: 'smtp', reachable: false });
    expect(JSON.stringify(view)).not.toContain(RELAY_PASSWORD);
    expect(JSON.stringify(view)).not.toContain(`127.0.0.1:${port}`);
  });

  it('startup diagnostics name the relay and the failure reason without the credential', async () => {
    await waitForOutput(
      instance,
      (output) => output.includes(`127.0.0.1:${port}`) && /unreachable|refused/i.test(output),
    );
    expect(instance.consoleLog()).not.toContain(RELAY_PASSWORD);
    expect(instance.consoleLog()).not.toContain(RELAY_USER);
  });
});

describe('missing SMTP deployment configuration fails startup loudly', () => {
  it('refuses to start with the SMTP binding when SMTP_HOST is unset', async () => {
    await expect(
      Instance.start(BACKEND_DIST, {
        MAIL_TRANSPORT_BINDING: 'smtp',
        SMTP_PORT: '2525',
        MAIL_FROM,
      }),
    ).rejects.toThrow(/SMTP_HOST/);
  });

  it('refuses to start when SMTP_USER is configured without SMTP_PASSWORD', async () => {
    await expect(
      Instance.start(BACKEND_DIST, {
        MAIL_TRANSPORT_BINDING: 'smtp',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '2525',
        SMTP_USER: RELAY_USER,
        MAIL_FROM,
      }),
    ).rejects.toThrow(/SMTP_PASSWORD/);
  });
});

describe('the capture binding remains the test binding', () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await Instance.start(BACKEND_DIST, { MAIL_TRANSPORT_BINDING: 'capture' });
  });

  afterAll(async () => {
    await instance?.stop();
  });

  it('is selected by configuration alone, with the capture surface mounted', async () => {
    const view = await health(instance);
    expect(view.status).toBe('ok');
    expect(view.mail).toEqual({ binding: 'capture', reachable: true });

    const sent = await instance.request('/dev/mail', {
      method: 'POST',
      body: { to: 'mohamed@example.com', subject: 'capture still works', body: 'body' },
    });
    expect(sent.status).toBe(201);
    expect((await instance.capturedEmails()).some((mail) => mail.subject === 'capture still works')).toBe(
      true,
    );
  });
});
