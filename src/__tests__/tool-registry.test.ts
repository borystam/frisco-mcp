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
}));

vi.mock('../auth.js', () => ({
  ensureLoggedIn: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn().mockResolvedValue(undefined),
  restoreSession: vi.fn().mockResolvedValue(false),
  isLoggedIn: vi.fn().mockResolvedValue(false),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn().mockResolvedValue(false),
}));

const registered: string[] = [];

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: class {
      registerTool(name: string, _opts: unknown, _handler: unknown) {
        registered.push(name);
      }
      connect() { return Promise.resolve(); }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('../logger.js', () => ({
  initLogger: vi.fn().mockResolvedValue(undefined),
  logEvent: vi.fn(),
  getCurrentSessionId: () => 'test',
  getCurrentSessionLogPath: () => '/tmp/x.jsonl',
  getLogs: vi.fn(),
  tailLogs: vi.fn(),
}));

describe('tool registry', () => {
  it('registers the expected tool names without throwing', async () => {
    registered.length = 0;
    await import('../index.js');
    // Registration happens at module-eval time.
    expect(registered).toContain('search_products');
    expect(registered).toContain('search_products_scored');
    expect(registered).toContain('get_product_info');
    expect(registered).toContain('get_product_reviews');
    expect(registered).toContain('add_items_to_cart');
    expect(registered).toContain('view_cart');
    expect(registered).toContain('clear_cart');
    expect(registered).toContain('remove_item_from_cart');
    expect(registered).toContain('check_cart_issues');
    expect(registered).toContain('view_promotions');
    expect(registered).toContain('update_item_quantity');
    expect(registered).toContain('get_delivery_slots');
    expect(registered).toContain('get_order_history');
  });

  it('registers no duplicate tool names', async () => {
    const seen = new Set(registered);
    expect(seen.size).toBe(registered.length);
  });
});
