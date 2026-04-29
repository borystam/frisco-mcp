import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We mock os.homedir() so logger writes go to a tmp directory we can
// inspect for credential leakage.
const TEST_DIR = join(tmpdir(), `frisco-mcp-cred-${Date.now()}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => TEST_DIR,
  };
});

interface MockLocator {
  waitFor: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  press: ReturnType<typeof vi.fn>;
}

interface MockPage {
  locator: ReturnType<typeof vi.fn>;
}

function makeLocator(opts: {
  visible?: boolean;
  fillImpl?: (value: string) => Promise<void>;
} = {}): MockLocator {
  const visible = opts.visible !== false;
  return {
    waitFor: vi.fn().mockImplementation(() =>
      visible ? Promise.resolve() : Promise.reject(new Error('not visible')),
    ),
    fill: vi.fn().mockImplementation((value: string) =>
      opts.fillImpl ? opts.fillImpl(value) : Promise.resolve(),
    ),
    press: vi.fn().mockResolvedValue(undefined),
  };
}

function makePage(map: Record<string, MockLocator>): MockPage {
  return {
    locator: vi.fn().mockImplementation((sel: string) => {
      const loc = map[sel];
      if (!loc) {
        // Return a locator whose waitFor rejects — emulates "no match".
        return {
          first: () => makeLocator({ visible: false }),
        };
      }
      return { first: () => loc };
    }),
  };
}

describe('attemptCredentialAutofill', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('skips when env vars are not set', async () => {
    const { attemptCredentialAutofill } = await import('../tools/session.js');
    const page = makePage({}) as unknown as import('playwright').Page;
    const result = await attemptCredentialAutofill(page, {});
    expect(result).toEqual({ attempted: false, filled: false });
  });

  it('skips when only FRISCO_USER is set', async () => {
    const { attemptCredentialAutofill } = await import('../tools/session.js');
    const page = makePage({}) as unknown as import('playwright').Page;
    const result = await attemptCredentialAutofill(page, { FRISCO_USER: 'a@b.c' });
    expect(result.attempted).toBe(false);
  });

  it('attempts but does not fill when no email selector matches', async () => {
    const { attemptCredentialAutofill } = await import('../tools/session.js');
    const page = makePage({}) as unknown as import('playwright').Page;
    const result = await attemptCredentialAutofill(page, {
      FRISCO_USER: 'user@example.test',
      FRISCO_PASS: 'pw',
    });
    expect(result).toEqual({ attempted: true, filled: false });
  });

  it('fills email + password and presses Enter when both fields are present', async () => {
    const userLoc = makeLocator();
    const passLoc = makeLocator();
    const page = makePage({
      'input[type="email"]': userLoc,
      'input[type="password"]': passLoc,
    }) as unknown as import('playwright').Page;
    const { attemptCredentialAutofill } = await import('../tools/session.js');
    const result = await attemptCredentialAutofill(page, {
      FRISCO_USER: 'user@example.test',
      FRISCO_PASS: 'pw',
    });
    expect(result).toEqual({ attempted: true, filled: true });
    expect(userLoc.fill).toHaveBeenCalledWith('user@example.test');
    expect(passLoc.fill).toHaveBeenCalledWith('pw');
    expect(passLoc.press).toHaveBeenCalledWith('Enter');
  });

  it('returns filled=false when fill itself throws', async () => {
    const userLoc = makeLocator({
      fillImpl: () => Promise.reject(new Error('detached')),
    });
    const passLoc = makeLocator();
    const page = makePage({
      'input[type="email"]': userLoc,
      'input[type="password"]': passLoc,
    }) as unknown as import('playwright').Page;
    const { attemptCredentialAutofill } = await import('../tools/session.js');
    const result = await attemptCredentialAutofill(page, {
      FRISCO_USER: 'user@example.test',
      FRISCO_PASS: 'pw',
    });
    expect(result).toEqual({ attempted: true, filled: false });
  });

  it('credentials never reach any JSONL log file', async () => {
    // Initialise the logger and log a few events so the file actually exists.
    const { initLogger, logEvent, getCurrentSessionLogPath } = await import('../logger.js');
    await initLogger();
    await logEvent('autofill_started', { someField: 'metadata-only' });
    await logEvent('autofill_finished', { result: { filled: true } });

    const userLoc = makeLocator();
    const passLoc = makeLocator();
    const page = makePage({
      'input[type="email"]': userLoc,
      'input[type="password"]': passLoc,
    }) as unknown as import('playwright').Page;

    const { attemptCredentialAutofill } = await import('../tools/session.js');
    const SECRET_USER = 'leaky-canary-user@example.test';
    const SECRET_PASS = 'leaky-canary-PASSWORD-VALUE';
    await attemptCredentialAutofill(page, {
      FRISCO_USER: SECRET_USER,
      FRISCO_PASS: SECRET_PASS,
    });

    // Sweep every JSONL log written by the test process.
    const logDir = join(TEST_DIR, '.frisco-mcp', 'logs');
    const files = await fs.readdir(logDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = await fs.readFile(join(logDir, f), 'utf-8');
      expect(raw).not.toContain(SECRET_USER);
      expect(raw).not.toContain(SECRET_PASS);
    }
    const currentSession = await fs.readFile(
      join(TEST_DIR, '.frisco-mcp', 'current-session.json'),
      'utf-8',
    );
    expect(currentSession).not.toContain(SECRET_USER);
    expect(currentSession).not.toContain(SECRET_PASS);

    // Sanity: confirm the log file we sampled is the current one.
    expect(getCurrentSessionLogPath()).toContain(logDir);
  });
});
