import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runHttp, readEnvOptions, type RunningHttpServer } from "./http-server.js";
import { closeBrowser } from "./browser.js";

import { login, finishSession, clearSession } from "./tools/session.js";
import {
  addItemsToCart,
  clearCart,
  viewCart,
  removeItemFromCart,
  checkCartIssues,
  viewPromotions,
  updateItemQuantity,
} from "./tools/cart.js";
import {
  searchProducts,
  searchProductsScored,
  getProductInfo,
  getProductReviews,
} from "./tools/products.js";
import { getDeliverySlots } from "./tools/delivery.js";
import { getOrderHistory } from "./tools/orders.js";
import {
  initLogger,
  logEvent,
  getCurrentSessionId,
  getCurrentSessionLogPath,
  getLogs,
  tailLogs,
} from "./logger.js";

// Tool registration is shared between the stdio singleton (long-lived) and
// the per-session McpServer instances created by the HTTP transport. The
// SDK's protocol layer cannot service multiple concurrent initialize
// handshakes on a single McpServer, so the HTTP path builds a fresh server
// per session via createServer().
export function createServer(): McpServer {
  const s = new McpServer({
    name: "frisco-mcp-ts",
    version: "1.0.0",
  });
  registerAllTools(s);
  return s;
}

function registerAllTools(server: McpServer): void {

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  run: () => Promise<string>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  await logEvent("tool_started", { toolName, input });
  try {
    const text = await run();
    await logEvent("tool_succeeded", {
      toolName,
      durationMs: Date.now() - startedAt,
      outputPreview: text.slice(0, 300),
    });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logEvent(
      "tool_failed",
      {
        toolName,
        durationMs: Date.now() - startedAt,
        error: message,
      },
      "error",
    );
    return {
      content: [{ type: "text", text: `❌ Error: ${message}` }],
      isError: true,
    };
  }
}

server.registerTool(
  "get_logs",
  {
    description:
      "Returns persisted JSONL log events for the current or selected session.",
    inputSchema: {
      sessionId: z
        .string()
        .optional()
        .describe("Optional session ID, defaults to current session"),
      limit: z
        .number()
        .optional()
        .describe("Max number of events to return (default 200, max 2000)"),
    },
  },
  async ({ sessionId, limit }) => {
    return executeTool("get_logs", { sessionId, limit }, () =>
      getLogs({ sessionId, limit }),
    );
  },
);

server.registerTool(
  "tail_logs",
  {
    description: "Returns the most recent events from persisted session logs.",
    inputSchema: {
      sessionId: z
        .string()
        .optional()
        .describe("Optional session ID, defaults to current session"),
      lines: z
        .number()
        .default(50)
        .describe("How many latest events to return (default 50, max 500)"),
    },
  },
  async ({ sessionId, lines }) => {
    return executeTool("tail_logs", { sessionId, lines }, () =>
      tailLogs(lines, sessionId),
    );
  },
);

server.registerTool(
  "login",
  {
    description:
      "Opens a visible Chromium browser to log in to Frisco manually. Run this first to establish a session.",
  },
  async () => {
    return executeTool("login", {}, () => login());
  },
);

server.registerTool(
  "finish_session",
  {
    description:
      "Opens the browser at the checkout page so you can select a delivery time and pay.",
  },
  async () => {
    return executeTool("finish_session", {}, () => finishSession());
  },
);

server.registerTool(
  "clear_session",
  {
    description: "Clears the saved session and closes the browser.",
  },
  async () => {
    return executeTool("clear_session", {}, () => clearSession());
  },
);

server.registerTool(
  "view_cart",
  {
    description: "Returns the current contents and total of the Frisco cart.",
  },
  async () => {
    return executeTool("view_cart", {}, () => viewCart());
  },
);

server.registerTool(
  "clear_cart",
  {
    description:
      "Empties the Frisco cart using the site's clear-cart button and confirmation dialog. Run view_cart if you need to verify.",
  },
  async () => {
    return executeTool("clear_cart", {}, () => clearCart());
  },
);

server.registerTool(
  "add_items_to_cart",
  {
    description:
      "Adds products to cart by selecting from the most recent search_products result page. No additional search is performed.",
    inputSchema: {
      items: z
        .string()
        .describe(
          'JSON array of items, e.g. [{"name":"PIĄTNICA Skyr naturalny","quantity":2}] or [{"name":"...","productUrl":"https://www.frisco.pl/pid,...","quantity":1}]',
        ),
      clearCartFirst: z
        .boolean()
        .default(false)
        .describe("If true, clears cart before adding items"),
    },
  },
  async ({ items, clearCartFirst }) => {
    return executeTool("add_items_to_cart", { items, clearCartFirst }, () =>
      addItemsToCart(items, {
        clearCartFirst,
        // Per-item progress: emits one log line as each cart item resolves,
        // so a long batch (15+ items) shows movement instead of going silent.
        onProgress: (event) => {
          void logEvent("cart_item_progress", {
            index: event.index,
            total: event.total,
            status: event.status,
            name: event.item.name ?? null,
            quantity: event.item.quantity ?? 1,
            messagePreview: event.message.slice(0, 200),
          });
        },
      }),
    );
  },
);

server.registerTool(
  "search_products",
  {
    description:
      "Searches frisco.pl for products, returns top matches with prices, and saves the search URL/context for add_items_to_cart.",
    inputSchema: {
      query: z.string().describe("Product name to search for"),
      topN: z
        .number()
        .default(5)
        .describe("Number of results to return (default 5)"),
    },
  },
  async ({ query, topN }) => {
    return executeTool("search_products", { query, topN }, () =>
      searchProducts(query, topN),
    );
  },
);

server.registerTool(
  "search_products_scored",
  {
    description:
      "Searches frisco.pl for products and ranks the top hits by user-supplied criteria. Each result has a 0-100 score with a per-criterion breakdown and a one-line reason. Use this when you want the best match for a query under explicit constraints (must/avoid keywords, lowest unit price, target pack size, prefer-keywords).",
    inputSchema: {
      query: z.string().describe("Product name to search for"),
      topN: z.number().default(5).describe("Number of scored results to return (default 5)"),
      must: z
        .array(z.string())
        .optional()
        .describe("Required substrings in the product name (case-insensitive). Items missing any of these score 0."),
      avoid: z
        .array(z.string())
        .optional()
        .describe("Forbidden substrings in the product name (case-insensitive). Items containing any of these score 0."),
      preferKeywords: z
        .array(z.string())
        .optional()
        .describe("Bonus keywords; partial matches add weight to the keyword component."),
      unitPriceWeight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Weight (0-1) for unit-price (PLN/kg or PLN/L) component. Default 0.4."),
      packSizeWeight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Weight (0-1) for pack-size proximity to targetWeightGrams. Default 0."),
      targetWeightGrams: z
        .number()
        .positive()
        .optional()
        .describe("Target pack size in grams (or ml). Used only when packSizeWeight > 0."),
      keywordWeight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Weight (0-1) for preferKeywords match component. Default 0.3."),
      availabilityWeight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Weight (0-1) for availability. Default 0.3."),
    },
  },
  async ({
    query,
    topN,
    must,
    avoid,
    preferKeywords,
    unitPriceWeight,
    packSizeWeight,
    targetWeightGrams,
    keywordWeight,
    availabilityWeight,
  }) => {
    return executeTool(
      "search_products_scored",
      {
        query,
        topN,
        must,
        avoid,
        preferKeywords,
        unitPriceWeight,
        packSizeWeight,
        targetWeightGrams,
        keywordWeight,
        availabilityWeight,
      },
      () =>
        searchProductsScored(
          query,
          {
            must,
            avoid,
            preferKeywords,
            unitPriceWeight,
            packSizeWeight,
            targetWeightGrams,
            keywordWeight,
            availabilityWeight,
          },
          topN,
        ),
    );
  },
);

server.registerTool(
  "get_product_info",
  {
    description:
      "Gets detailed info for a product: nutritional values (macros per 100g), weight/grammage, ingredients, and price.",
    inputSchema: {
      query: z.string().describe("Product name or search query"),
    },
  },
  async ({ query }) => {
    return executeTool("get_product_info", { query }, () =>
      getProductInfo(query),
    );
  },
);

server.registerTool(
  "remove_item_from_cart",
  {
    description:
      "Removes a specific product from the Frisco cart by name (partial match supported).",
    inputSchema: {
      productName: z
        .string()
        .describe("Full or partial name of the product to remove"),
    },
  },
  async ({ productName }) => {
    return executeTool("remove_item_from_cart", { productName }, () =>
      removeItemFromCart(productName),
    );
  },
);

server.registerTool(
  "check_cart_issues",
  {
    description:
      "Checks the cart for sold-out or unavailable products and lists available substitutes for each.",
  },
  async () => {
    return executeTool("check_cart_issues", {}, () => checkCartIssues());
  },
);

server.registerTool(
  "get_product_reviews",
  {
    description:
      "Gets customer reviews and ratings for a product from Trustmate.",
    inputSchema: {
      query: z.string().describe("Product name or search query"),
      limit: z
        .number()
        .default(5)
        .describe("Max number of reviews to return (default 5)"),
    },
  },
  async ({ query, limit }) => {
    return executeTool("get_product_reviews", { query, limit }, () =>
      getProductReviews(query, limit),
    );
  },
);

server.registerTool(
  "view_promotions",
  {
    description:
      "Shows active promotions, discounts, and total savings in the current cart.",
  },
  async () => {
    return executeTool("view_promotions", {}, () => viewPromotions());
  },
);

server.registerTool(
  "update_item_quantity",
  {
    description:
      "Changes the quantity of a product already in the cart (partial name match supported).",
    inputSchema: {
      productName: z.string().describe("Full or partial name of the product"),
      quantity: z.number().describe("New quantity to set"),
    },
  },
  async ({ productName, quantity }) => {
    return executeTool("update_item_quantity", { productName, quantity }, () =>
      updateItemQuantity(productName, quantity),
    );
  },
);

server.registerTool(
  "get_delivery_slots",
  {
    description:
      "Reads the Frisco 'choose delivery' page and returns the available delivery slot grid (per-day, per-hour) with prices, availability, and any banner notes. Optional filters: time-of-day (morning/afternoon/evening), maxPricePln, limit. Use after the cart has items but before placing the order; the user still confirms checkout in the browser.",
    inputSchema: {
      preferTimeOfDay: z
        .enum(['morning', 'afternoon', 'evening'])
        .optional()
        .describe("Restrict to a coarse time bucket (morning=05–12, afternoon=12–18, evening=18–23)"),
      maxPricePln: z
        .number()
        .min(0)
        .optional()
        .describe("Cap the slot delivery fee in PLN."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum number of matching slots to return."),
      onlyAvailable: z
        .boolean()
        .default(true)
        .describe("If false, also include unavailable slots (greyed out on the page)."),
    },
  },
  async ({ preferTimeOfDay, maxPricePln, limit, onlyAvailable }) => {
    return executeTool(
      "get_delivery_slots",
      { preferTimeOfDay, maxPricePln, limit, onlyAvailable },
      () => getDeliverySlots({ preferTimeOfDay, maxPricePln, limit, onlyAvailable }),
    );
  },
);

server.registerTool(
  "get_order_history",
  {
    description:
      "Reads the user's past Frisco orders from /stn,user-orders and returns a summary list (order ID, placed-at, status, total) plus a spend total. Optional filters: fromDate, toDate (ISO YYYY-MM-DD), status substring, minTotalPln, limit.",
    inputSchema: {
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Inclusive lower-bound on placed-at date (YYYY-MM-DD)."),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Inclusive upper-bound on placed-at date (YYYY-MM-DD)."),
      status: z
        .string()
        .optional()
        .describe("Substring match on status label (case-insensitive)."),
      minTotalPln: z
        .number()
        .min(0)
        .optional()
        .describe("Only orders with total >= this PLN amount."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum number of orders to return."),
    },
  },
  async ({ fromDate, toDate, status, minTotalPln, limit }) => {
    return executeTool(
      "get_order_history",
      { fromDate, toDate, status, minTotalPln, limit },
      () => getOrderHistory({ fromDate, toDate, status, minTotalPln, limit }),
    );
  },
);
} // end registerAllTools

const SHUTDOWN_BUDGET_MS = 10_000;

interface RunningServer {
  close: () => Promise<void>;
}

async function run(): Promise<void> {
  await initLogger();
  const transportName = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
  await logEvent("server_starting", {
    sessionId: getCurrentSessionId(),
    sessionLogPath: getCurrentSessionLogPath(),
    transport: transportName,
  });

  let running: RunningServer;
  if (transportName === "http") {
    const opts = readEnvOptions();
    const r: RunningHttpServer = await runHttp(createServer, opts);
    running = { close: () => r.close() };
  } else if (transportName === "stdio" || transportName === "") {
    const stdio = new StdioServerTransport();
    const stdioServer = createServer();
    await stdioServer.connect(stdio);
    running = { close: async () => stdioServer.close() };
  } else {
    throw new Error(
      `MCP_TRANSPORT must be 'stdio' or 'http', got ${JSON.stringify(transportName)}`,
    );
  }

  installSignalHandlers(running);
  await logEvent("server_started");
}

function installSignalHandlers(running: RunningServer): void {
  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown(signal, running);
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}

async function shutdown(signal: string, running: RunningServer): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
  const hardExit = setTimeout(() => {
    process.stderr.write(`[frisco-mcp] shutdown deadline exceeded on ${signal}, forcing exit\n`);
    process.exit(1);
  }, SHUTDOWN_BUDGET_MS);
  hardExit.unref();
  try {
    await logEvent("server_stopping", { signal });
    await running.close();
    const browserBudget = Math.max(1_000, deadline - Date.now());
    await Promise.race([
      closeBrowser(),
      new Promise<void>((resolve) => setTimeout(resolve, browserBudget).unref()),
    ]);
    await logEvent("server_stopped", { signal });
  } catch (err) {
    process.stderr.write(
      `[frisco-mcp] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    clearTimeout(hardExit);
    process.exit(0);
  }
}

run().catch((error) => {
  void logEvent(
    "server_fatal_error",
    {
      message: error instanceof Error ? error.message : String(error),
    },
    "error",
  );
  process.stderr.write(`[frisco-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
