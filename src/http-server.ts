// HTTP transport for the MCP server.
//
// Selected via MCP_TRANSPORT=http. Stateful, JSON-response mode (no SSE) —
// the Frisco workload is request/response, not streaming. Stateful mode
// means each MCP client's initialize → notifications/initialized → tool-call
// sequence is bound to a Mcp-Session-Id, which the SDK's standard client
// negotiates automatically. Stateless mode tripped the SDK's per-request
// protocol layer for non-initialize requests.
//
// Hardening:
//   - Bearer auth via constant-time compare (crypto.timingSafeEqual).
//   - Refuses to bind a non-loopback address unless MCP_HTTP_BEARER is set.
//   - Configurable body-size cap (default 1 MB) → 413 on overflow.
//   - Configurable idle/header timeouts (default 30 s) bound to slow-client
//     resilience.
//   - GET /healthz is always public (200 ok\n) and never exposes internal
//     state — it is a liveness probe; consumers wanting readiness must
//     issue an authenticated tools/list call.
//   - Unknown paths → 404; unsupported methods on /mcp → 405 with Allow.
//   - JSON parse failure → 400, no body echo.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  bearer: string | null;
  bodyLimitBytes: number;
  idleTimeoutMs: number;
  mcpPath: string;
  healthPath: string;
}

export interface RunningHttpServer {
  httpServer: Server;
  address: { host: string; port: number };
  close: () => Promise<void>;
  // Read-only view; tests rely on it for liveness assertions.
  readonly sessionCount: () => number;
}

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "ip6-localhost",
]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

const DEFAULT_PORT = 3031;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_HEALTH_PATH = "/healthz";

export function readEnvOptions(
  env: NodeJS.ProcessEnv = process.env,
): HttpServerOptions {
  const host = (env.MCP_HTTP_HOST ?? "").trim() || DEFAULT_HOST;
  const portRaw = (env.MCP_HTTP_PORT ?? "").trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(
      `MCP_HTTP_PORT must be 0..65535, got ${JSON.stringify(env.MCP_HTTP_PORT)}`,
    );
  }

  const bearer = (env.MCP_HTTP_BEARER ?? "").trim() || null;
  if (!isLoopbackHost(host) && !bearer) {
    throw new Error(
      `MCP_HTTP_HOST=${host} is non-loopback but MCP_HTTP_BEARER is not set; refusing to start`,
    );
  }

  const bodyLimitRaw = (env.MCP_HTTP_BODY_LIMIT_BYTES ?? "").trim();
  const bodyLimitBytes = bodyLimitRaw
    ? parsePositiveInt(bodyLimitRaw, "MCP_HTTP_BODY_LIMIT_BYTES")
    : DEFAULT_BODY_LIMIT_BYTES;

  const idleRaw = (env.MCP_HTTP_IDLE_TIMEOUT_MS ?? "").trim();
  const idleTimeoutMs = idleRaw
    ? parsePositiveInt(idleRaw, "MCP_HTTP_IDLE_TIMEOUT_MS")
    : DEFAULT_IDLE_TIMEOUT_MS;

  return {
    host,
    port,
    bearer,
    bodyLimitBytes,
    idleTimeoutMs,
    mcpPath: (env.MCP_HTTP_PATH ?? "").trim() || DEFAULT_MCP_PATH,
    healthPath: (env.MCP_HTTP_HEALTHZ_PATH ?? "").trim() || DEFAULT_HEALTH_PATH,
  };
}

function parsePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function bearerEqual(provided: string | undefined, expected: string): boolean {
  // Constant-time compare. timingSafeEqual requires equal-length buffers, so
  // wrong-length inputs short-circuit — but we still run a dummy compare to
  // even out the wall-clock cost a little. Length is intrinsically observable
  // via response timing of any HTTP server, so this is a best-effort defense
  // against character-by-character comparison oracles.
  const expectedBuf = Buffer.from(expected, "utf-8");
  if (typeof provided !== "string") {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  const providedBuf = Buffer.from(provided, "utf-8");
  if (providedBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

function extractBearer(authHeader: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : undefined;
}

interface BodyReadResult {
  body: Buffer;
  tooLarge: boolean;
}

async function readBodyWithLimit(
  req: IncomingMessage,
  limit: number,
): Promise<BodyReadResult> {
  return new Promise<BodyReadResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;
    const settle = (value: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        // Mark and drop further bytes, but keep reading so the response can
        // flush cleanly. Idle/header timeouts on the http.Server bound how
        // long a malicious client can stretch this.
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      settle({ body: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge }),
    );
    req.on("close", () =>
      settle({ body: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge }),
    );
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

export async function runHttp(
  serverFactory: () => McpServer,
  options: HttpServerOptions,
): Promise<RunningHttpServer> {
  // Canonical SDK pattern for stateful Streamable HTTP: one McpServer per
  // session. The protocol layer cannot service two concurrent initialize
  // handshakes on a single McpServer (rejects with "Server already
  // initialized"). We build a fresh server + transport pair on every new
  // initialize and key them by the generated Mcp-Session-Id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res, serverFactory, transports, options).catch((err) => {
      process.stderr.write(
        `[frisco-mcp-http] request handler error: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      try {
        sendJsonError(res, 500, "internal server error");
      } catch {
        /* response already sent */
      }
    });
  });

  // Slow-client / idle protection.
  httpServer.requestTimeout = options.idleTimeoutMs;
  httpServer.headersTimeout = Math.max(5_000, options.idleTimeoutMs - 1_000);
  httpServer.keepAliveTimeout = options.idleTimeoutMs;

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => {
      httpServer.removeListener("listening", onListening);
      reject(e);
    };
    const onListening = (): void => {
      httpServer.removeListener("error", onErr);
      resolve();
    };
    httpServer.once("error", onErr);
    httpServer.once("listening", onListening);
    httpServer.listen(options.port, options.host);
  });

  const addr = httpServer.address();
  const realPort =
    typeof addr === "object" && addr ? addr.port : options.port;

  // Single-line startup log to stderr only — no env dump, no paths beyond
  // the public bind address.
  process.stderr.write(
    `[frisco-mcp-http] listening transport=streamable-http host=${options.host} port=${realPort} auth=${options.bearer ? "on" : "off"}\n`,
  );

  return {
    httpServer,
    address: { host: options.host, port: realPort },
    sessionCount: () => transports.size,
    async close() {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Force-close idle keepalive sockets so we exit promptly.
        httpServer.closeAllConnections?.();
      });
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          /* best effort */
        }
      }
      transports.clear();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: () => McpServer,
  transports: Map<string, StreamableHTTPServerTransport>,
  options: HttpServerOptions,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  // Strip query string for path matching.
  const path = url.split("?", 1)[0];

  // Health probe — public, always 200, no internal state.
  if (method === "GET" && path === options.healthPath) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end("ok\n");
    return;
  }

  if (path !== options.mcpPath) {
    sendJsonError(res, 404, "not found");
    return;
  }

  const allowedMethods = new Set(["GET", "POST", "DELETE"]);
  if (!allowedMethods.has(method)) {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, DELETE");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (options.bearer) {
    const provided = extractBearer(req.headers.authorization);
    if (!bearerEqual(provided, options.bearer)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  let parsedBody: unknown = undefined;
  if (method === "POST") {
    const { body, tooLarge } = await readBodyWithLimit(req, options.bodyLimitBytes);
    if (tooLarge) {
      sendJsonError(res, 413, "request body exceeds limit");
      return;
    }
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString("utf-8"));
      } catch {
        sendJsonError(res, 400, "invalid JSON body");
        return;
      }
    }
  }

  // Per-session transport dispatch.
  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, parsedBody);
    return;
  }

  if (method === "POST" && isInitializeRequest(parsedBody)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
      onsessionclosed: (sid) => {
        transports.delete(sid);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };
    const sessionServer = serverFactory();
    await sessionServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  // No session and not an initialize: spec says reject with 400.
  sendJsonError(res, 400, "missing session — call initialize first");
}
