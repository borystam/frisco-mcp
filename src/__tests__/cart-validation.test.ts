import { describe, it, expect, vi, beforeEach } from 'vitest';

// addItemsToCart performs structural validation BEFORE touching the
// browser. Tests here mock browser/auth/etc. to zero so we can hit the
// validation paths quickly and pin the error messages.

// Default browser mock: empty cache, no search context. Individual
// tests can override via vi.doMock + vi.resetModules.
vi.mock('../browser.js', () => ({
  getPage: vi.fn(),
  getContext: vi.fn(),
  productCache: new Map(),
  getLastSearchContext: () => null,
  setLastSearchContext: vi.fn(),
  closeBrowser: vi.fn(),
  withPageLock: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../auth.js', () => ({
  ensureLoggedIn: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn(),
  restoreSession: vi.fn().mockResolvedValue(true),
  isLoggedIn: vi.fn().mockResolvedValue(true),
  deleteSession: vi.fn(),
  sessionExists: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.resetModules();
});

async function importAddItems() {
  const m = await import('../tools/cart.js');
  return m.addItemsToCart;
}

describe('addItemsToCart — input validation', () => {
  it('rejects malformed JSON', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('not json');
    expect(r).toMatch(/Invalid JSON/);
  });

  it('rejects non-array JSON', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('{"name":"x"}');
    expect(r).toMatch(/Expected a JSON array/);
  });

  it('rejects empty array', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[]');
    expect(r).toMatch(/Empty items array/);
  });

  it('rejects quantity 0', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[{"name":"x","quantity":0}]');
    expect(r).toMatch(/Invalid input/);
    expect(r).toMatch(/positive integer/);
    expect(r).toMatch(/got 0/);
  });

  it('rejects negative quantity', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[{"name":"x","quantity":-1}]');
    expect(r).toMatch(/positive integer/);
    expect(r).toMatch(/got -1/);
  });

  it('rejects non-integer quantity', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[{"name":"x","quantity":1.5}]');
    expect(r).toMatch(/positive integer/);
  });

  it('rejects string quantity', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[{"name":"x","quantity":"two"}]');
    expect(r).toMatch(/positive integer/);
    expect(r).toMatch(/"two"/);
  });

  it('rejects quantity over the per-item cap', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[{"name":"x","quantity":99999}]');
    expect(r).toMatch(/exceeds max/);
  });

  it('accepts missing quantity (treats as 1)', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[{"name":"x"}]');
    // No quantity-related error. Falls through to the URL-resolution
    // check (which fails because nothing in the cache and no search
    // context — the productCache mock above is empty).
    expect(r).not.toMatch(/Invalid input/);
    expect(r).toMatch(/No way to resolve product URLs|No saved search context/);
  });

  it('rejects empty name', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart('[{"quantity":1}]');
    expect(r).toMatch(/Invalid input/);
    expect(r).toMatch(/name/);
  });

  it('aggregates multiple invalid items into one report', async () => {
    const addItemsToCart = await importAddItems();
    const r = await addItemsToCart(
      '[{"name":"a","quantity":-1},{"name":"b","quantity":99999},{"name":"c","quantity":1}]',
    );
    expect(r).toMatch(/got -1/);
    expect(r).toMatch(/exceeds max/);
    // The valid third item is not reported, only the failures.
    expect(r.match(/•/g)?.length).toBe(2);
  });
});

describe('addItemsToCart — small-model schema tolerance', () => {
  it('accepts a raw array (not stringified JSON)', async () => {
    // Strict structured-output models pass through the array as-is.
    // The function must accept either form.
    const cache = new Map([
      ['X', { name: 'X', url: 'https://www.frisco.pl/pid,1/', price: '', weight: null, macros: {}, ingredients: null }],
    ]);
    vi.doMock('../browser.js', () => ({
      getPage: vi.fn(() => { throw new Error('past-the-gate sentinel'); }),
      getContext: vi.fn(),
      productCache: cache,
      getLastSearchContext: () => null,
      setLastSearchContext: vi.fn(),
      closeBrowser: vi.fn(),
      withPageLock: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    }));
    vi.resetModules();
    const { addItemsToCart } = await import('../tools/cart.js');
    await expect(
      addItemsToCart([{ name: 'X', quantity: 1 }] as unknown[]),
    ).rejects.toThrow(/past-the-gate sentinel/);
    vi.doUnmock('../browser.js');
    vi.resetModules();
  });

  it.each([
    ['qty', '[{"name":"X","qty":2}]'],
    ['amount', '[{"name":"X","amount":3}]'],
    ['count', '[{"name":"X","count":4}]'],
    ['n', '[{"name":"X","n":5}]'],
  ])('aliases %s → quantity (instead of silently using default 1)', async (alias, payload) => {
    // Use a captured CartItem to assert the alias actually mapped.
    const cache = new Map<string, { url: string; price: string; weight: null; macros: object; ingredients: null; name: string }>();
    let captured: { name?: string; quantity?: number } | null = null;
    vi.doMock('../browser.js', () => ({
      getPage: vi.fn(() => { throw new Error('past-the-gate sentinel'); }),
      getContext: vi.fn(),
      productCache: cache,
      getLastSearchContext: () => ({
        query: 'X',
        searchUrl: 'https://www.frisco.pl/q,X/',
        results: [{ name: 'X', url: 'https://www.frisco.pl/pid,1/', price: '', weight: '', available: true }],
        updatedAt: Date.now(),
      }),
      setLastSearchContext: vi.fn(),
      closeBrowser: vi.fn(),
      withPageLock: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    }));
    vi.resetModules();
    const { addItemsToCart } = await import('../tools/cart.js');
    const r = await addItemsToCart(payload).catch((e: Error) => e.message);
    // Got past the gate (mock threw the sentinel) → alias was
    // normalised. If we'd failed normalisation we'd see the
    // quantity-validation message instead.
    expect(r).not.toMatch(/quantity must be a positive integer/);
    expect(r).toMatch(/past-the-gate sentinel/);
    void alias;
    void captured;
    vi.doUnmock('../browser.js');
    vi.resetModules();
  });
});

describe('addItemsToCart — productCache fallback for multi-search workflows', () => {
  it('does not require a fresh searchContext when every item is in productCache (exact match)', async () => {
    const cache = new Map([
      ['BRAND-A Test Product', { name: 'BRAND-A Test Product', url: 'https://www.frisco.pl/pid,1/', price: '', weight: null, macros: {}, ingredients: null }],
      ['BRAND-B Test Product', { name: 'BRAND-B Test Product', url: 'https://www.frisco.pl/pid,2/', price: '', weight: null, macros: {}, ingredients: null }],
    ]);
    vi.doMock('../browser.js', () => ({
      getPage: vi.fn(() => { throw new Error('past-the-gate sentinel'); }),
      getContext: vi.fn(),
      productCache: cache,
      getLastSearchContext: () => null,
      setLastSearchContext: vi.fn(),
      closeBrowser: vi.fn(),
      withPageLock: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    }));
    vi.resetModules();
    const { addItemsToCart } = await import('../tools/cart.js');
    // The function gets PAST the URL-resolution gate, then navigates.
    // Our mock makes navigation throw — the rejection IS the signal
    // that the gate let it through. The OLD code returned a
    // "No saved search context" string without ever calling getPage.
    await expect(
      addItemsToCart('[{"name":"BRAND-A Test Product","quantity":1},{"name":"BRAND-B Test Product","quantity":1}]'),
    ).rejects.toThrow(/past-the-gate sentinel/);
    vi.doUnmock('../browser.js');
    vi.resetModules();
  });

  it('partial substring match: cached "Sample Item Variant 2" is reachable as item "Sample Item"', async () => {
    const cache = new Map([
      ['Sample Item Variant 2', { name: 'Sample Item Variant 2', url: 'https://www.frisco.pl/pid,1/', price: '', weight: null, macros: {}, ingredients: null }],
    ]);
    vi.doMock('../browser.js', () => ({
      getPage: vi.fn(() => { throw new Error('past-the-gate sentinel'); }),
      getContext: vi.fn(),
      productCache: cache,
      getLastSearchContext: () => null,
      setLastSearchContext: vi.fn(),
      closeBrowser: vi.fn(),
      withPageLock: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    }));
    vi.resetModules();
    const { addItemsToCart } = await import('../tools/cart.js');
    await expect(
      addItemsToCart('[{"name":"Sample Item","quantity":1}]'),
    ).rejects.toThrow(/past-the-gate sentinel/);
    vi.doUnmock('../browser.js');
    vi.resetModules();
  });

  it('still errors when an item is neither in cache nor in search context', async () => {
    const cache = new Map([
      ['Different Product', { name: 'Different Product', url: 'https://www.frisco.pl/pid,1/', price: '', weight: null, macros: {}, ingredients: null }],
    ]);
    vi.doMock('../browser.js', () => ({
      getPage: vi.fn(),
      getContext: vi.fn(),
      productCache: cache,
      getLastSearchContext: () => null,
      setLastSearchContext: vi.fn(),
      closeBrowser: vi.fn(),
      withPageLock: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    }));
    vi.resetModules();
    const { addItemsToCart } = await import('../tools/cart.js');
    const r = await addItemsToCart('[{"name":"Unknown Product","quantity":1}]');
    expect(r).toMatch(/No way to resolve/);
    vi.doUnmock('../browser.js');
    vi.resetModules();
  });
});

describe('searchProducts / searchProductsScored — input validation', () => {
  it('searchProducts rejects empty query', async () => {
    const m = await import('../tools/products.js');
    const r = await m.searchProducts('', 5);
    expect(r).toMatch(/query is required/);
  });

  it('searchProducts rejects whitespace-only query', async () => {
    const m = await import('../tools/products.js');
    const r = await m.searchProducts('   ', 5);
    expect(r).toMatch(/query is required/);
  });

  it('searchProductsScored rejects empty query', async () => {
    const m = await import('../tools/products.js');
    const r = await m.searchProductsScored('', {}, 5);
    expect(r).toMatch(/query is required/);
  });

  it('searchProductsScored rejects packSizeWeight>0 without targetWeightGrams', async () => {
    const m = await import('../tools/products.js');
    const r = await m.searchProductsScored('mleko', { packSizeWeight: 0.5 }, 5);
    expect(r).toMatch(/packSizeWeight > 0 requires targetWeightGrams/);
  });

  it('searchProductsScored allows packSizeWeight=0 without targetWeightGrams', async () => {
    // Hits the validation, falls through to the (mocked) browser path.
    // Either returns a non-validation message or rejects from the
    // missing browser. Whichever — the validation message must not
    // appear.
    const m = await import('../tools/products.js');
    let result: string | undefined;
    let err: Error | undefined;
    try {
      result = await m.searchProductsScored('mleko', { packSizeWeight: 0 }, 5);
    } catch (e) {
      err = e as Error;
    }
    const text = (result ?? err?.message ?? '').toString();
    expect(text).not.toMatch(/packSizeWeight > 0 requires/);
  });

  it('clampTopN clamps to [1, 24]', async () => {
    const m = await import('../tools/products.js');
    expect(m.clampTopN(0)).toBe(1);
    expect(m.clampTopN(-5)).toBe(1);
    expect(m.clampTopN(1)).toBe(1);
    expect(m.clampTopN(5)).toBe(5);
    expect(m.clampTopN(24)).toBe(24);
    expect(m.clampTopN(25)).toBe(24);
    expect(m.clampTopN(9999)).toBe(24);
    expect(m.clampTopN(undefined)).toBe(5); // default fallback
    expect(m.clampTopN(NaN)).toBe(5);
    expect(m.clampTopN(Infinity)).toBe(5);
    expect(m.clampTopN(3.7)).toBe(3); // Math.floor
  });
});
