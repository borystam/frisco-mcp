import { describe, it, expect, vi } from 'vitest';

// Mock everything that touches the network/Playwright so importing
// src/index.ts is safe in a test runner. We only care that the
// McpServer.registerTool calls succeed and produce the expected names.

vi.mock('../browser.js', () => ({
  getPage: vi.fn(),
  getContext: vi.fn(),
  getLastSearchContext: () => null,
  productCache: new Map(),
  setLastSearchContext: vi.fn(),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../auth.js', () => ({
  ensureLoggedIn: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn().mockResolvedValue(undefined),
  restoreSession: vi.fn().mockResolvedValue(false),
  isLoggedIn: vi.fn().mockResolvedValue(false),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn().mockResolvedValue(false),
}));

interface Registration {
  name: string;
  description?: string;
}

const registered: Registration[] = [];

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: class {
      registerTool(name: string, opts: { description?: string }, _handler: unknown) {
        registered.push({ name, description: opts?.description });
      }
      connect() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('../http-server.js', () => ({
  runHttp: vi.fn().mockResolvedValue({
    httpServer: { close: (cb: () => void) => cb() },
    transport: {},
    address: { host: '127.0.0.1', port: 0 },
    close: vi.fn().mockResolvedValue(undefined),
  }),
  readEnvOptions: vi.fn(),
  isLoopbackHost: vi.fn().mockReturnValue(true),
}));

vi.mock('../logger.js', () => ({
  initLogger: vi.fn().mockResolvedValue(undefined),
  logEvent: vi.fn(),
  getCurrentSessionId: () => 'test',
  getCurrentSessionLogPath: () => '/tmp/x.jsonl',
  getLogs: vi.fn(),
  tailLogs: vi.fn(),
}));

// Item 8: lock the public tool surface to this exact set. Reordering or
// renaming a tool is a breaking change for any consumer; require an
// explicit, reviewable diff to this test rather than letting it slip in.
const EXPECTED_TOOLS = [
  'get_logs',
  'tail_logs',
  'login',
  'finish_session',
  'clear_session',
  'view_cart',
  'clear_cart',
  'add_items_to_cart',
  'search_products',
  'search_products_scored',
  'get_product_info',
  'remove_item_from_cart',
  'check_cart_issues',
  'get_product_reviews',
  'view_promotions',
  'update_item_quantity',
  'get_delivery_slots',
  'get_order_history',
] as const;

describe('tool registry', () => {
  it('registers the expected tool names without throwing', async () => {
    registered.length = 0;
    await import('../index.js');
    const names = registered.map((r) => r.name);
    expect(names).toContain('search_products');
    expect(names).toContain('search_products_scored');
    expect(names).toContain('get_product_info');
    expect(names).toContain('get_product_reviews');
    expect(names).toContain('add_items_to_cart');
    expect(names).toContain('view_cart');
    expect(names).toContain('clear_cart');
    expect(names).toContain('remove_item_from_cart');
    expect(names).toContain('check_cart_issues');
    expect(names).toContain('view_promotions');
    expect(names).toContain('update_item_quantity');
    expect(names).toContain('get_delivery_slots');
    expect(names).toContain('get_order_history');
  });

  it('registers no duplicate tool names', async () => {
    const names = registered.map((r) => r.name);
    const seen = new Set(names);
    expect(seen.size).toBe(names.length);
  });

  it('exposes the locked tool surface — no extras, no missing', () => {
    const names = registered.map((r) => r.name);
    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOLS));
    expect(names.length).toBe(EXPECTED_TOOLS.length);
  });

  it('every tool has a non-empty description', () => {
    for (const r of registered) {
      expect(r.description, `tool ${r.name} missing description`).toBeTruthy();
      expect(r.description!.length).toBeGreaterThan(10);
    }
  });
});
