import { getPage, getContext, closeBrowser, isBrowserOpen } from '../browser.js';
import {
  saveSession,
  deleteSession,
  sessionExists,
  SESSION_PATH,
} from '../auth.js';

async function resetAuthStateForLogin(page: import('playwright').Page): Promise<void> {
  const context = page.context();
  await context.clearCookies();

  try {
    await page.goto('https://www.frisco.pl/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
  } catch {
  }
}

// Optional credential autofill driven entirely by environment variables.
// When FRISCO_USER and FRISCO_PASS are both set, attempt to fill the visible
// login form before the cookie-poll loop runs. On any selector miss the
// function returns silently and the caller falls through to the existing
// manual flow.
//
// Credentials are NEVER routed through any logger, never echoed to stdout,
// and never returned in any tool response. See the test in
// src/__tests__/credential-autofill.test.ts.
export interface CredentialAutofillResult {
  attempted: boolean;
  filled: boolean;
}

export async function attemptCredentialAutofill(
  page: import('playwright').Page,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialAutofillResult> {
  const user = (env.FRISCO_USER ?? '').trim();
  const pass = env.FRISCO_PASS ?? '';
  if (!user || !pass) {
    return { attempted: false, filled: false };
  }

  const userSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input#email',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
  ];
  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input#password',
    'input[autocomplete="current-password"]',
  ];

  const findField = async (
    selectors: string[],
  ): Promise<import('playwright').Locator | null> => {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        await loc.waitFor({ state: 'visible', timeout: 1_500 });
        return loc;
      } catch {
        /* try next */
      }
    }
    return null;
  };

  const userField = await findField(userSelectors);
  if (!userField) return { attempted: true, filled: false };
  const passField = await findField(passSelectors);
  if (!passField) return { attempted: true, filled: false };

  try {
    await userField.fill(user);
    await passField.fill(pass);
    // Press Enter to submit; if no handler is bound, the existing cookie-
    // poll loop downstream still drives the manual flow.
    await passField.press('Enter');
  } catch {
    return { attempted: true, filled: false };
  }
  return { attempted: true, filled: true };
}

export async function login(): Promise<string> {
  const page = await getPage();
  const context = await getContext();

  await resetAuthStateForLogin(page);

  await page.goto('https://www.frisco.pl/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_000);

  try {
    await page.getByRole('button', { name: 'Akceptuję' }).click({ timeout: 3_000 });
    await page.waitForTimeout(800);
  } catch {}

  try {
    await page.click('button.modal-new_close', { timeout: 2_000 });
    await page.waitForTimeout(500);
  } catch {}

  // Best-effort autofill. Runs only when FRISCO_USER/FRISCO_PASS are set;
  // any selector failure silently drops back to the manual flow.
  await attemptCredentialAutofill(page).catch(() => undefined);

  const POLL_INTERVAL = 2_000;
  const TIMEOUT_MS = 5 * 60 * 1_000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const url = page.url();
    if (!url.includes('login')) {
      const hasAccountEl = await page.evaluate(() => {
        return !!(
          document.querySelector('[class*="logout"]') ||
          document.querySelector('[href*="logout"]') ||
          document.querySelector('[href*="wyloguj"]') ||
          document.querySelector('[data-testid="account-menu"]') ||
          document.querySelector('[class*="UserMenu"]') ||
          document.querySelector('[class*="user-menu"]')
        );
      });

      // Frisco's old /stn,home redirect target now 404s — accept any
      // landing on the root or any /stn,home (legacy) as a successful
      // post-login redirect.
      const onHome =
        url === 'https://www.frisco.pl/' ||
        url === 'https://www.frisco.pl' ||
        url.startsWith('https://www.frisco.pl/?') ||
        url.includes('/stn,home');
      if (hasAccountEl || onHome) {
        await saveSession(context);
        return (
          '✅ Logged in successfully! Session cookies saved to ' +
          SESSION_PATH +
          '\n\nYou can now use cart and product tools. ' +
          'The browser window will stay open — close it manually or use clear_session.' +
          '\n\nNEXT: if the user asked you to log in as part of a larger task, immediately continue with the next step (search, view_cart, etc.). Do not stop here.'
        );
      }
    }
    await page.waitForTimeout(POLL_INTERVAL);
  }

  return (
    '⚠️ Login timeout (5 minutes). ' +
    'The browser is still open — log in manually and then call login again, ' +
    'or call clear_session to reset.'
  );
}

export async function finishSession(): Promise<string> {
  const CART_URL = 'https://www.frisco.pl/stn,cart';

  if (!(await sessionExists())) {
    return '❌ No saved session. Please run login first.';
  }

  const page = await getPage();
  const context = await getContext();

  const { restoreSession } = await import('../auth.js');
  await restoreSession(context);

  await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_500);

  return (
    '🛒 Browser is now open at your cart:\n' +
    CART_URL +
    '\n\nReview your items, select delivery slot, and complete payment.\n' +
    '⚠️ The agent will NOT make payment on your behalf — this step is yours.'
  );
}

export async function clearSession(): Promise<string> {
  const hadBrowser = isBrowserOpen();
  await closeBrowser();
  await deleteSession();

  const parts: string[] = [];
  if (hadBrowser) parts.push('🔒 Browser closed.');
  parts.push('🗑️ Session file deleted.');
  parts.push('You can run login again to start a new session.');
  return parts.join('\n');
}
