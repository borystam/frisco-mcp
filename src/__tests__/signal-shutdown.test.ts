import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// Deliverable 4+17: graceful SIGTERM/SIGINT shutdown.
// Spawn the real entrypoint via tsx, wait until it is listening, send the
// signal, and assert the child exits 0 within the shutdown budget. The
// browser is never opened in HTTP mode without a tool call, so we cover
// the transport-close path without needing Playwright/Chromium.

const SHUTDOWN_BUDGET_MS = 10_000;

let active: ChildProcessWithoutNullStreams | null = null;
let activeHome: string | null = null;

afterEach(() => {
  if (active && active.exitCode === null) {
    try {
      active.kill('SIGKILL');
    } catch {}
  }
  active = null;
  if (activeHome) {
    try {
      rmSync(activeHome, { recursive: true, force: true });
    } catch {}
    activeHome = null;
  }
});

interface StartedChild {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string;
}

async function startChild(): Promise<StartedChild> {
  const home = mkdtempSync(join(tmpdir(), 'frisco-mcp-sig-'));
  activeHome = home;
  // Spawn the tsx CLI directly via the Node binary — `npx tsx` adds an npm
  // wrapper layer that consumes signals and turns SIGTERM into a death
  // (exit code 143) for the wrapper instead of forwarding to our code.
  const child = spawn(
    process.execPath,
    ['./node_modules/tsx/dist/cli.mjs', 'src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        MCP_TRANSPORT: 'http',
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_HTTP_PORT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  active = child;
  let stderr = '';
  let port: number | null = null;
  await new Promise<void>((resolve, reject) => {
    const onErr = (chunk: Buffer): void => {
      const s = chunk.toString('utf-8');
      stderr += s;
      const m = /port=(\d+)\s+auth=/.exec(s);
      if (m && port === null) {
        port = Number(m[1]);
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`child exited before listening (code=${code}); stderr=${stderr}`));
    };
    const cleanup = (): void => {
      child.stderr.off('data', onErr);
      child.off('exit', onExit);
    };
    child.stderr.on('data', onErr);
    child.once('exit', onExit);
    setTimeout(() => {
      cleanup();
      reject(new Error(`child did not signal listening within 30s; stderr=${stderr}`));
    }, 30_000).unref();
  });
  if (port === null) throw new Error('port not parsed');
  return { child, port, stderr };
}

async function curlHealth(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/healthz', method: 'GET' },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeout: number): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`process did not exit within ${timeout}ms`)), timeout);
    t.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, durationMs: Date.now() - start });
    });
  });
}

describe('graceful shutdown', () => {
  it('SIGTERM exits 0 within the budget', async () => {
    const { child, port } = await startChild();
    const status = await curlHealth(port);
    expect(status).toBe(200);
    child.kill('SIGTERM');
    const result = await waitForExit(child, SHUTDOWN_BUDGET_MS + 2_000);
    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(SHUTDOWN_BUDGET_MS);
  }, 45_000);

  it('SIGINT exits 0 within the budget', async () => {
    const { child, port } = await startChild();
    const status = await curlHealth(port);
    expect(status).toBe(200);
    child.kill('SIGINT');
    const result = await waitForExit(child, SHUTDOWN_BUDGET_MS + 2_000);
    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(SHUTDOWN_BUDGET_MS);
  }, 45_000);

  it('a second SIGTERM during shutdown does not flap the exit code', async () => {
    const { child } = await startChild();
    child.kill('SIGTERM');
    // Quickly send another; the once() handler should drop it.
    setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }, 50);
    const result = await waitForExit(child, SHUTDOWN_BUDGET_MS + 2_000);
    expect(result.code).toBe(0);
  }, 45_000);
});
