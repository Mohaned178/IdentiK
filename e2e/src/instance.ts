import { ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 */
export class Instance {
  private child?: ChildProcess;
  private disposed = false;

  private constructor(
    readonly url: string,
    private readonly stateDir: string,
  ) {}

  static async start(backendDist: string): Promise<Instance> {
    const stateDir = join(
      tmpdir(),
      `identik-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(stateDir, { recursive: true });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, [join(backendDist, 'main.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        IDENTIK_STATE_DIR: stateDir,
        MAIL_TRANSPORT_BINDING: 'capture',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const instance = new Instance(url, stateDir);
    instance.child = child;
    try {
      await waitUntilHealthy(url, child);
    } catch (error) {
      await instance.stop();
      throw error;
    }
    return instance;
  }

  async request(
    path: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<Response> {
    const url = new URL(path, this.url);
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const serialized = init?.body === undefined ? undefined : JSON.stringify(init.body);
    return fetch(url, {
      method: init?.method ?? 'GET',
      headers:
        serialized === undefined
          ? init?.headers
          : { 'content-type': 'application/json', ...init?.headers },
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

  async stop(): Promise<void> {
    if (this.disposed || !this.child) return;
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    child.kill();
    await onceExit(child);
    rmSync(this.stateDir, { recursive: true, force: true });
  }
}

async function waitUntilHealthy(url: string, child: ChildProcess): Promise<void> {
  const output: string[] = [];
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Instance exited before becoming healthy (code ${child.exitCode}). Output:\n${output.join('')}`,
      );
    }
    try {
      const res = await fetch(new URL('/health', url));
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`Instance did not become healthy within 30s. Output:\n${output.join('')}`);
}

function onceExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
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

export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
