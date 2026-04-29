import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Item 10 (file-mode regression) and Item 18 (concurrent login safety):
// these tests lock the audit-required file modes (0700/0600) after a
// realistic-shape login flow, and assert that two parallel saveSession
// calls do not race-corrupt session.json.

const TEST_DIR = join(tmpdir(), `frisco-mcp-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => TEST_DIR,
  };
});

describe('file-mode regression', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('after a fake login + log run, dir is 0700 and all sensitive files are 0600', async () => {
    // 1) Initialise the logger so current-session.json + a *.jsonl log exist.
    const { initLogger, logEvent } = await import('../logger.js');
    await initLogger();
    await logEvent('test_event', { ok: true });

    // 2) Fake the cookie-write step that login() ends with.
    const { saveSession } = await import('../auth.js');
    const ctx = {
      cookies: vi.fn().mockResolvedValue([
        { name: 'sid', value: 'fake', domain: 'frisco.pl', path: '/' },
      ]),
    } as unknown as import('playwright').BrowserContext;
    await saveSession(ctx);

    const dataDir = join(TEST_DIR, '.frisco-mcp');
    const sessionPath = join(dataDir, 'session.json');
    const currentSessionPath = join(dataDir, 'current-session.json');
    const logDir = join(dataDir, 'logs');

    const dataDirStat = await fs.stat(dataDir);
    expect(dataDirStat.mode & 0o777).toBe(0o700);

    const logDirStat = await fs.stat(logDir);
    expect(logDirStat.mode & 0o777).toBe(0o700);

    const sessionStat = await fs.stat(sessionPath);
    expect(sessionStat.mode & 0o777).toBe(0o600);

    const currentStat = await fs.stat(currentSessionPath);
    expect(currentStat.mode & 0o777).toBe(0o600);

    const logFiles = await fs.readdir(logDir);
    expect(logFiles.length).toBeGreaterThan(0);
    for (const f of logFiles) {
      const s = await fs.stat(join(logDir, f));
      expect(s.mode & 0o777, `log file ${f} mode`).toBe(0o600);
    }
  });

  it('tightens permissions even when the data dir pre-exists with a loose mode', async () => {
    const dataDir = join(TEST_DIR, '.frisco-mcp');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o755 });
    await fs.chmod(dataDir, 0o755);

    const { saveSession } = await import('../auth.js');
    const ctx = {
      cookies: vi.fn().mockResolvedValue([]),
    } as unknown as import('playwright').BrowserContext;
    await saveSession(ctx);

    const stat = await fs.stat(dataDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe('concurrent login safety', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('two parallel saveSession calls leave a valid JSON cookie list on disk', async () => {
    const { saveSession } = await import('../auth.js');
    const cookiesA = [
      { name: 'sid', value: 'A', domain: 'frisco.pl', path: '/' },
    ];
    const cookiesB = [
      { name: 'sid', value: 'B', domain: 'frisco.pl', path: '/' },
      { name: 'csrf', value: 'token', domain: 'frisco.pl', path: '/' },
    ];
    const ctxA = {
      cookies: vi.fn().mockResolvedValue(cookiesA),
    } as unknown as import('playwright').BrowserContext;
    const ctxB = {
      cookies: vi.fn().mockResolvedValue(cookiesB),
    } as unknown as import('playwright').BrowserContext;

    await Promise.all([saveSession(ctxA), saveSession(ctxB)]);

    const sessionPath = join(TEST_DIR, '.frisco-mcp', 'session.json');
    const raw = await fs.readFile(sessionPath, 'utf-8');
    // Must be valid JSON whatever the order; not a half-written interleave.
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    // The winner is one of the two cookie sets, not a corrupted blend.
    const expectedA = JSON.stringify(cookiesA);
    const expectedB = JSON.stringify(cookiesB);
    expect([expectedA, expectedB]).toContain(JSON.stringify(parsed));

    // And the file mode is still tight after the race.
    const stat = await fs.stat(sessionPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('rapidly-repeated saveSession does not loosen permissions', async () => {
    const { saveSession } = await import('../auth.js');
    const ctx = {
      cookies: vi.fn().mockResolvedValue([
        { name: 'sid', value: 'x', domain: 'frisco.pl', path: '/' },
      ]),
    } as unknown as import('playwright').BrowserContext;
    for (let i = 0; i < 10; i++) {
      await saveSession(ctx);
    }
    const sessionPath = join(TEST_DIR, '.frisco-mcp', 'session.json');
    const stat = await fs.stat(sessionPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
