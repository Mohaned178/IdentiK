import { ChildProcess, spawn } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { databaseNameFor, databaseUrl, dropDatabase, ensureDatabase } from './provision';

export interface CapturedEmail {
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

/**
 * A live IdentiK Instance under test. Everything the harness does to the
 * Instance goes through its HTTP surface (Seam 1) and the captured-email
 * surface (Seam 2) — never storage, token internals, or module structure.
 * The Instance's own console output is observable to the harness (the
 * bootstrap ceremony reveals its one-time token there).
 *
 * Persistence is provisioned, not inspected: each Instance gets a fresh
 * database cloned from the run's migrated template, and the harness drops it
 * on stop. A key reused across two starts — a restart — reuses its database,
 * which is how durability is tested.
 */
export class Instance {
  private child?: ChildProcess;
  private disposed = false;
  private readonly consoleOutput: string[] = [];

  private constructor(
    readonly url: string,
    readonly databaseName: string,
  ) {}

  static async start(backendDist: string, env: Record<string, string> = {}): Promise<Instance> {
    const key = `identik-instance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return Instance.startAt(backendDist, key, env);
  }

  /**
   * Starts an Instance against the database named by `databaseKey`. A key
   * already provisioned is reused — used to test durable behavior across
   * restarts (same storage, new process).
   */
  static async startAt(
    backendDist: string,
    databaseKey: string,
    env: Record<string, string> = {},
  ): Promise<Instance> {
    const databaseName = databaseNameFor(databaseKey);
    await ensureDatabase(databaseName);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, [join(backendDist, 'main.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: databaseUrl(databaseName),
        IDENTIK_BASE_URL: url,
        MAIL_TRANSPORT_BINDING: 'capture',
        // The suite runs the Instance in development mode: captured mail and
        // ephemeral signing keys. Production-strict tests clear it explicitly.
        IDENTIK_DEV_MODE: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const instance = new Instance(url, databaseName);
    instance.child = child;
    child.stdout?.on('data', (chunk) => instance.consoleOutput.push(String(chunk)));
    child.stderr?.on('data', (chunk) => instance.consoleOutput.push(String(chunk)));
    try {
      await waitUntilHealthy(url, child);
    } catch (error) {
      const output = instance.consoleLog().trim();
      await instance.stop();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}` +
          (output ? `\n--- Instance output ---\n${output}` : ''),
      );
    }
    return instance;
  }

  /** Everything the Instance has printed to stdout/stderr so far. */
  consoleLog(): string {
    return this.consoleOutput.join('');
  }

  /**
   * The Bootstrap Ceremony's one-time token. The ceremony is initiated from the
   * install process, so the console is its operator surface: this is the only
   * place the token is revealed, and it is never re-minted (the harness never
   * derives it from storage).
   */
  setupToken(): string {
    const match = [...this.consoleLog().matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1);
    if (!match) throw new Error('no setup token in console output');
    return match[1]!;
  }

  async request(
    path: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      form?: Record<string, string>;
      redirect?: 'follow' | 'error' | 'manual';
    },
  ): Promise<Response> {
    const url = new URL(path, this.url);
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const serialized = init?.form
      ? new URLSearchParams(init.form).toString()
      : init?.body === undefined
        ? undefined
        : JSON.stringify(init.body);
    return fetch(url, {
      method: init?.method ?? 'GET',
      redirect: init?.redirect ?? 'follow',
      headers:
        serialized === undefined
          ? init?.headers
          : {
              'content-type': init?.form
                ? 'application/x-www-form-urlencoded'
                : 'application/json',
              ...init?.headers,
            },
      body: serialized,
    });
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /** Seam 2: outbound email captured by this Instance's in-memory transport. */
  async capturedEmails(): Promise<CapturedEmail[]> {
    const res = await this.request('/dev/mail');
    if (!res.ok) {
      throw new Error(`GET /dev/mail failed: ${res.status}`);
    }
    const body = (await res.json()) as { emails: CapturedEmail[] };
    return body.emails;
  }

  async stop(options: { keepState?: boolean } = {}): Promise<void> {
    if (this.disposed || !this.child) return;
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    child.kill();
    await onceExit(child);
    if (!options.keepState) {
      await dropDatabase(this.databaseName);
    }
  }

  /** Send SIGTERM; the Instance is expected to drain its in-flight work and exit. */
  async terminate(): Promise<void> {
    if (this.disposed || !this.child) return;
    this.child.kill('SIGTERM');
  }

  /** Resolve with the exit code when the process exits; reject if it outlives the timeout. */
  async waitForExit(timeoutMs = 15_000): Promise<number | null> {
    const child = this.child;
    if (!child) throw new Error('the Instance is not running');
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        onceExit(child),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`the Instance did not exit within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return child.exitCode;
  }
}

async function waitUntilHealthy(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Instance exited before becoming healthy (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(new URL('/health/ready', url));
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error('Instance did not become healthy within 30s');
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A currently free loopback port, for pointing an Instance at a known-dead address. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function backendDistFromWorkspaceRoot(root: string): string {
  return join(root, 'backend', 'dist');
}

/**
 * Starts an Instance that is expected to refuse to boot (bad configuration or
 * a schema gate). Returns the process output — the refusal message an
 * operator would see — and throws when the Instance served traffic instead.
 */
export async function startupRefusal(starting: Promise<Instance>): Promise<string> {
  let instance: Instance;
  try {
    instance = await starting;
  } catch (error) {
    return String(error);
  }
  await instance.stop();
  throw new Error('expected the Instance to refuse to start, but it served traffic');
}

export { WORKSPACE_ROOT } from './provision';
