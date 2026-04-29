import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Page, BrowserContext } from 'playwright';

const DATA_DIR = join(homedir(), '.frisco-mcp');
export const SESSION_PATH = join(DATA_DIR, 'session.json');

// Owner-only file mode for the session cookie file (rw-------).
// Prevents other local users from reading session cookies.
const SESSION_FILE_MODE = 0o600;
const SESSION_DIR_MODE = 0o700;

export async function saveSession(context: BrowserContext): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: SESSION_DIR_MODE });
  // Best-effort: tighten dir mode if it pre-existed with looser permissions.
  try {
    await fs.chmod(DATA_DIR, SESSION_DIR_MODE);
  } catch {}
  const cookies = await context.cookies();
  await fs.writeFile(SESSION_PATH, JSON.stringify(cookies, null, 2), {
    encoding: 'utf-8',
    mode: SESSION_FILE_MODE,
  });
  // writeFile only sets mode on file creation; chmod after to be safe.
  try {
    await fs.chmod(SESSION_PATH, SESSION_FILE_MODE);
  } catch {}
}

export async function restoreSession(context: BrowserContext): Promise<boolean> {
  try {
    const raw = await fs.readFile(SESSION_PATH, 'utf-8');
    const cookies = JSON.parse(raw);
    await context.addCookies(cookies);
    return true;
  } catch {
    return false;
  }
}

export async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  try {
    const response = await context.request.get('https://www.frisco.pl/stn,user-account', {
      timeout: 12_000,
      failOnStatusCode: false,
    });
    const finalUrl = response.url();
    if (finalUrl.includes('/login') || finalUrl.includes('/stn,login')) return false;
    return response.status() < 500;
  } catch {
    return true;
  }
}

export async function ensureLoggedIn(page: Page, context: BrowserContext): Promise<void> {
  const restored = await restoreSession(context);
  if (!restored) {
    throw new Error(
      'No saved session found. Please run the "login" tool first to log in via the browser.'
    );
  }
  const ok = await isLoggedIn(context);
  if (!ok) {
    throw new Error(
      'Session expired or invalid. Please run the "login" tool again to re-authenticate.'
    );
  }
  // Make sure the page is parked on frisco.pl before the caller goes
  // poking at site-specific selectors (search box, cart UI, …). After a
  // fresh browser launch the page is on about:blank, where every
  // Frisco-specific locator times out.
  let url = '';
  try {
    url = page.url();
  } catch {
    // page may be closed; let the caller re-open via getPage()
  }
  if (!url || !/^https?:\/\/(www\.)?frisco\.pl\b/i.test(url)) {
    try {
      await page.goto('https://www.frisco.pl/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      // Best-effort: a navigation failure here will surface naturally
      // when the next selector lookup times out, with a more
      // actionable error than a blank goto failure.
    }
  }
}

export async function deleteSession(): Promise<void> {
  try {
    await fs.unlink(SESSION_PATH);
  } catch {
  }
}

export async function sessionExists(): Promise<boolean> {
  try {
    await fs.access(SESSION_PATH);
    return true;
  } catch {
    return false;
  }
}
