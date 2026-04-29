# frisco-mcp — fork notes

This file tracks the divergence of `borystam/frisco-mcp` from upstream
`mkidawa/frisco-mcp`. It is intentionally short — design docs live in
the corresponding PRs.

## Why fork

Phase 0 audit (see [AUDIT.md](./AUDIT.md)) found two file-mode security
issues and four transitive CVEs in the upstream `master`. The audit
verdict was **DEPLOY-AFTER-FIXES**; we wanted to ship the fixes plus a
small set of targeted feature additions without waiting on upstream
review cycles. The fork's policy is: contribute generally-useful
fixes back upstream when stable; keep personal-shopping-specific
features here.

## What this fork adds (Phase 1)

| Area | Change |
| --- | --- |
| Security | `~/.frisco-mcp/session.json`, `~/.frisco-mcp/logs/*.jsonl`, and `~/.frisco-mcp/current-session.json` are written with mode `0o600`; the parent dirs with `0o700`. |
| Dependencies | `npm audit fix` clears 1 high (vite path-traversal) and 3 moderate transitive CVEs. `package.json` unchanged; only `package-lock.json`. |
| New tool: `search_products_scored` | Deterministic ranker over Frisco search results with a configurable feature set (must/avoid keywords, unit price PLN/kg, pack-size proximity, prefer-keywords, availability). Returns per-criterion breakdowns and a one-line reason. |
| New tool: `get_delivery_slots` | Reads the Frisco "choose delivery" page and surfaces the slot grid (per-day, per-hour, with prices and availability). Filters: time-of-day, max price, limit. |
| New tool: `get_order_history` | Reads the Frisco "your orders" page and returns past orders as a JSON-friendly list with date-range / status / min-total filters. Appends a spend summary. |
| Streaming progress | `add_items_to_cart` now emits one `cart_item_progress` JSONL event per item instead of going silent for 30s+ on long batches. The MCP reply text is unchanged. |
| Tests | +84 new unit/integration tests across scoring, delivery, orders, cart streaming, tool-registry, and auth file-mode regressions. Total suite: 211 tests, all green on Node 20 and 22. |
| CI | Workflow now runs on `claude/**` branches in addition to `master`, gates on `tsc --noEmit`, and runs `npm audit --audit-level=high` advisory. |

## What this fork does NOT change

- Upstream's tool surface (`search_products`, `get_product_info`,
  `get_product_reviews`, `view_cart`, `clear_cart`,
  `remove_item_from_cart`, `check_cart_issues`, `view_promotions`,
  `update_item_quantity`) is preserved verbatim.
- The browser launch defaults (headed Chromium) are unchanged.
- No telemetry, anti-bot stealth, or third-party API additions.
- No license or maintainer changes.

## How to keep in sync with upstream

```
git remote add upstream https://github.com/mkidawa/frisco-mcp.git
git fetch upstream
git merge upstream/master
```

The fork branches under `claude/**` are scratch — squash-merge or
cherry-pick to `master` as PRs land.

## Phase 2 (in progress)

| Area | Status |
| --- | --- |
| HTTP transport (`StreamableHTTPServerTransport`) selectable via `MCP_TRANSPORT=http` | landed |
| Bearer auth, body-size cap, idle/headers timeouts, refusal to bind non-loopback without bearer | landed |
| `GET /healthz` liveness probe | landed |
| Optional credential autofill in `login` driven by `FRISCO_USER` / `FRISCO_PASS` (env-only, never logged) | landed |
| Container build: `Dockerfile` + `docker/entrypoint.sh` + `docker-compose.example.yml` (Xvfb, x11vnc, noVNC for one-time login) | landed |
| Graceful `SIGTERM` / `SIGINT` shutdown with a 10 s budget (browser teardown included) | landed |
| Tool-surface snapshot test, file-mode regression test, concurrent-login race test | landed |
| CI: secret scan, banned-string gate, container smoke (build → `/healthz` → stop) | landed |
| End-to-end test against real `frisco.pl` | owner's responsibility — outside CI, requires real credentials |
| Upstream-worthy fixes filed as a PR to `mkidawa/frisco-mcp` | pending |

## Open issues from upstream

Upstream issue enumeration was out of scope for the audit run. Sync
manually before backporting fixes.
