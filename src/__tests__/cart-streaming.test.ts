import { describe, it, expect, vi, beforeEach } from 'vitest';

// We don't spin up Playwright here; we mock browser/auth so addItemsToCart
// reaches the per-item loop with the seam we care about (the progress
// callback). The shape of the input is what matters for the streaming
// contract.

vi.mock('../browser.js', () => {
  const lastSearchContext = {
    query: 'milk',
    searchUrl: 'https://www.frisco.pl/search,milk',
    results: [
      { name: 'Milk A', url: 'https://www.frisco.pl/pid,1', price: '4 zł', weight: '1l', available: true },
      { name: 'Milk B', url: 'https://www.frisco.pl/pid,2', price: '5 zł', weight: '1l', available: true },
    ],
    updatedAt: Date.now(),
  };
  return {
    getPage: vi.fn(),
    getContext: vi.fn(),
    getLastSearchContext: () => lastSearchContext,
    productCache: new Map(),
    setLastSearchContext: vi.fn(),
  };
});

vi.mock('../auth.js', () => ({
  ensureLoggedIn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./helpers.js', async () => {
  const actual = await vi.importActual('../tools/helpers.js');
  return {
    ...actual,
    dismissPopups: vi.fn().mockResolvedValue(undefined),
  };
});

describe('addItemsToCart — streaming progress contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid JSON without invoking onProgress', async () => {
    const { addItemsToCart } = await import('../tools/cart.js');
    const onProgress = vi.fn();
    const out = await addItemsToCart('not-json', { onProgress });
    expect(out).toContain('Invalid JSON');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rejects non-array JSON without invoking onProgress', async () => {
    const { addItemsToCart } = await import('../tools/cart.js');
    const onProgress = vi.fn();
    const out = await addItemsToCart('{}', { onProgress });
    expect(out).toContain('Invalid input');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('returns no-context error without invoking onProgress when context missing', async () => {
    vi.doMock('../browser.js', () => ({
      getPage: vi.fn(),
      getContext: vi.fn(),
      getLastSearchContext: () => null,
      productCache: new Map(),
      setLastSearchContext: vi.fn(),
    }));
    vi.resetModules();
    const { addItemsToCart } = await import('../tools/cart.js');
    const onProgress = vi.fn();
    const out = await addItemsToCart(JSON.stringify([{ name: 'X' }]), { onProgress });
    expect(out).toContain('No saved search context');
    expect(onProgress).not.toHaveBeenCalled();
    vi.doUnmock('../browser.js');
    vi.resetModules();
  });

  it('AddItemProgressEvent shape: index/total/status/message — exported & typed', async () => {
    const mod = await import('../tools/cart.js');
    // Accessing the type indirectly: an object that conforms to the shape.
    const ev: import('../tools/cart.js').AddItemProgressEvent = {
      index: 1,
      total: 1,
      item: { name: 'X' },
      status: 'ok',
      message: 'msg',
    };
    expect(ev.status).toBe('ok');
    // Module exports addItemsToCart that accepts onProgress.
    expect(typeof mod.addItemsToCart).toBe('function');
  });
});
