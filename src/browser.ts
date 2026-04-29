import { chromium, Browser, BrowserContext, Page } from "playwright";
import type { Product, SearchContext } from "./types.js";

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _page: Page | null = null;

export const productCache = new Map<string, Product>();
let _lastSearchContext: SearchContext | null = null;

export function setLastSearchContext(context: SearchContext): void {
  _lastSearchContext = context;
}

export function getLastSearchContext(): SearchContext | null {
  return _lastSearchContext;
}

// Module-level FIFO mutex around the singleton browser/page. Every tool
// that touches the browser must run inside withPageLock; otherwise
// concurrent callers race on the same Page object — the last navigate
// wins and earlier callers parse the wrong DOM. The mutex spans MCP
// sessions because the browser singleton itself is module-scoped.
let _pageLock: Promise<unknown> = Promise.resolve();
export async function withPageLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = _pageLock.catch(() => undefined);
  let release!: () => void;
  _pageLock = new Promise<void>((r) => {
    release = r;
  });
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

export async function getPage(): Promise<Page> {
  if (_browser !== null && !_browser.isConnected()) {
    await closeBrowser();
  }
  if (_page && _browser?.isConnected()) return _page;

  _browser = await chromium.launch({ headless: false });
  _context = await _browser.newContext({ locale: "pl-PL" });
  _page = await _context.newPage();
  return _page;
}

export async function getContext(): Promise<BrowserContext> {
  if (_context) return _context;
  await getPage();
  return _context!;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    try {
      await _browser.close();
    } catch {}
  }
  _browser = null;
  _context = null;
  _page = null;
  productCache.clear();
  _lastSearchContext = null;
}

export function isBrowserOpen(): boolean {
  return _browser !== null;
}
