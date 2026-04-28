import { afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  isLoopbackHost,
  readEnvOptions,
  runHttp,
  type HttpServerOptions,
  type RunningHttpServer,
} from "../http-server.js";

interface FixtureServer {
  running: RunningHttpServer;
  baseUrl: string;
  bearer: string;
}

let active: FixtureServer | null = null;

async function startFixture(
  partial: Partial<HttpServerOptions> = {},
): Promise<FixtureServer> {
  const bearer = partial.bearer === null ? "" : (partial.bearer ?? "test-token");
  const opts: HttpServerOptions = {
    host: "127.0.0.1",
    port: 0,
    bearer: partial.bearer === null ? null : bearer,
    bodyLimitBytes: partial.bodyLimitBytes ?? 64 * 1024,
    idleTimeoutMs: partial.idleTimeoutMs ?? 5_000,
    mcpPath: partial.mcpPath ?? "/mcp",
    healthPath: partial.healthPath ?? "/healthz",
  };
  const server = new McpServer({ name: "frisco-mcp-test", version: "0.0.0" });
  server.registerTool(
    "ping",
    {
      description: "test ping tool",
      inputSchema: { msg: z.string().optional() },
    },
    async ({ msg }) => ({
      content: [{ type: "text", text: `pong:${msg ?? ""}` }],
    }),
  );
  const running = await runHttp(server, opts);
  return {
    running,
    baseUrl: `http://${running.address.host}:${running.address.port}`,
    bearer,
  };
}

afterEach(async () => {
  if (active) {
    await active.running.close();
    active = null;
  }
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function rawRequest(
  baseUrl: string,
  init: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResponse> {
  const url = new URL(init.path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

describe("readEnvOptions", () => {
  it("uses sane defaults", () => {
    const opts = readEnvOptions({} as NodeJS.ProcessEnv);
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.port).toBe(3031);
    expect(opts.bearer).toBeNull();
    expect(opts.bodyLimitBytes).toBe(1 * 1024 * 1024);
    expect(opts.idleTimeoutMs).toBe(30_000);
    expect(opts.mcpPath).toBe("/mcp");
    expect(opts.healthPath).toBe("/healthz");
  });

  it("isLoopbackHost recognises common loopbacks", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LocalHost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    // 203.0.0.113 is TEST-NET-3 (RFC 5737) — documentation-only range,
    // safe to reference in a public test.
    expect(isLoopbackHost("203.0.113.1")).toBe(false);
  });

  it("refuses non-loopback bind without bearer", () => {
    expect(() =>
      readEnvOptions({ MCP_HTTP_HOST: "0.0.0.0" } as NodeJS.ProcessEnv),
    ).toThrow(/non-loopback.*MCP_HTTP_BEARER/);
  });

  it("allows non-loopback bind with bearer", () => {
    const opts = readEnvOptions({
      MCP_HTTP_HOST: "0.0.0.0",
      MCP_HTTP_BEARER: "abc",
    } as NodeJS.ProcessEnv);
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.bearer).toBe("abc");
  });

  it("rejects malformed port", () => {
    expect(() =>
      readEnvOptions({ MCP_HTTP_PORT: "not-a-port" } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_HTTP_PORT/);
    expect(() =>
      readEnvOptions({ MCP_HTTP_PORT: "70000" } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_HTTP_PORT/);
  });

  it("rejects non-positive limits", () => {
    expect(() =>
      readEnvOptions({ MCP_HTTP_BODY_LIMIT_BYTES: "0" } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_HTTP_BODY_LIMIT_BYTES/);
    expect(() =>
      readEnvOptions({ MCP_HTTP_IDLE_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_HTTP_IDLE_TIMEOUT_MS/);
  });
});

describe("HTTP transport — health and routing", () => {
  it("GET /healthz returns 200 without auth", async () => {
    active = await startFixture();
    const res = await rawRequest(active.baseUrl, { path: "/healthz" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok\n");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("GET /healthz still 200 even if a bearer is configured", async () => {
    active = await startFixture({ bearer: "secret" });
    const res = await rawRequest(active.baseUrl, { path: "/healthz" });
    expect(res.status).toBe(200);
  });

  it("unknown paths return 404", async () => {
    active = await startFixture();
    const res = await rawRequest(active.baseUrl, { path: "/who-knows" });
    expect(res.status).toBe(404);
  });

  it("unsupported methods on /mcp return 405 with Allow header", async () => {
    active = await startFixture();
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "PUT",
      headers: { Authorization: `Bearer ${active.bearer}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, POST, DELETE");
  });

  it("query strings on /healthz are stripped from the path match", async () => {
    active = await startFixture();
    const res = await rawRequest(active.baseUrl, { path: "/healthz?probe=1" });
    expect(res.status).toBe(200);
  });
});

describe("HTTP transport — auth", () => {
  it("rejects POST /mcp without bearer when one is configured", async () => {
    active = await startFixture({ bearer: "right" });
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("rejects wrong bearer without echoing the supplied value", async () => {
    active = await startFixture({ bearer: "right-token" });
    const wrong = "WRONG-LEAKED-TOKEN-DO-NOT-ECHO";
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${wrong}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(wrong);
    expect(res.body).not.toContain("right-token");
  });

  it("accepts the configured bearer", async () => {
    active = await startFixture({ bearer: "right" });
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer right",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "0.0.0" },
          capabilities: {},
        },
      }),
    });
    // Initialize succeeds (200) and returns a JSON-RPC result.
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result.serverInfo.name).toBe("frisco-mcp-test");
  });

  it("auth is case-insensitive for the 'Bearer' scheme keyword", async () => {
    active = await startFixture({ bearer: "right" });
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "bearer right",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "0.0.0" },
          capabilities: {},
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("missing-bearer 401 does not leak the configured token in body or headers", async () => {
    const secret = "super-secret-do-not-leak";
    active = await startFixture({ bearer: secret });
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.body).not.toContain(secret);
    for (const [, v] of Object.entries(res.headers)) {
      const flat = Array.isArray(v) ? v.join("\n") : v ?? "";
      expect(flat).not.toContain(secret);
    }
  });
});

describe("HTTP transport — request hygiene", () => {
  it("invalid JSON body returns 400", async () => {
    active = await startFixture({ bearer: "" });
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("body over the limit returns 413", async () => {
    active = await startFixture({ bodyLimitBytes: 256, bearer: "" });
    const oversized = "x".repeat(2_000);
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: oversized }),
    });
    expect(res.status).toBe(413);
  });

  it("body exactly at the limit is accepted (validation reaches transport)", async () => {
    active = await startFixture({ bodyLimitBytes: 1024, bearer: "" });
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "noop" });
    expect(payload.length).toBeLessThanOrEqual(1024);
    const res = await rawRequest(active.baseUrl, {
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: payload,
    });
    // Body wasn't rejected for size; protocol-level error from the transport
    // would be 4xx but not 413.
    expect(res.status).not.toBe(413);
  });

  it("concurrent /healthz requests all resolve 200", async () => {
    active = await startFixture();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rawRequest(active!.baseUrl, { path: "/healthz" }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);
  });
});

describe("HTTP transport — startup banner contains no secrets", () => {
  let originalWrite: typeof process.stderr.write;
  let captured = "";

  beforeAll(() => {
    originalWrite = process.stderr.write.bind(process.stderr);
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    captured = "";
  });

  it("banner does not include the bearer value", async () => {
    process.stderr.write = ((chunk: unknown) => {
      captured += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    active = await startFixture({ bearer: "do-not-print-me" });
    expect(captured).toContain("listening");
    expect(captured).toContain("auth=on");
    expect(captured).not.toContain("do-not-print-me");
  });
});
