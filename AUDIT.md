# Frisco MCP — Phase 0 Audit

Verdict: **DEPLOY-AFTER-FIXES** — all fixes included in this PR.

This audit covers the fork at `borystam/frisco-mcp` against branch `claude/frisco-mcp-phase-1-uqaz9`. Methodology: static review of `src/`, `npm audit --json`, manifest grep, dependency-tree walk, supply-chain blacklist check, licence check.

---

## Summary

| Area | Finding | Severity | Status |
| --- | --- | --- | --- |
| Cookie file mode | `~/.frisco-mcp/session.json` written with default umask, not 0600 | High | Fixed |
| Log file mode | `~/.frisco-mcp/logs/*.jsonl` and `current-session.json` written with default umask | Moderate | Fixed |
| Direct CVEs | None in direct dependencies | — | Clean |
| Transitive CVEs (pre-fix) | 4 (3 moderate, 1 high) all transitive via `@modelcontextprotocol/sdk` and `vitest` | Moderate-High | Fixed via `npm audit fix` |
| Supply-chain blacklist | Clean (no `event-stream`, `colors`, `faker`, `ua-parser-js`, `node-ipc` etc.) | — | Clean |
| Stealth/anti-bot deps | None (no `puppeteer-extra-plugin-stealth`, `playwright-extra`, etc.) | — | Clean |
| Outbound destinations | Only `frisco.pl` reached at runtime; README links are docs-only | — | Clean |
| Licences | All direct deps MIT or Apache-2.0 | — | Clean |
| Logging hygiene | Tool outputs are truncated to 300 chars in logs; tool input echoed in full | Low | Documented |
| Process hygiene | `closeBrowser()` swallows errors but nulls handles; orphan risk only on hard kill | Low | Documented |

---

## 1. Cookie file permissions (FIXED)

**Finding.** `src/auth.ts::saveSession` wrote `~/.frisco-mcp/session.json` via `fs.writeFile(path, data, 'utf-8')` with no mode argument. On Linux with default umask 0022 the file ends up world-readable (`rw-r--r--`). Any other local user can copy a Frisco session cookie and impersonate the user against frisco.pl.

**Fix.** Patched `src/auth.ts` to:
- create `~/.frisco-mcp` with mode `0o700`,
- write `session.json` with mode `0o600`,
- `chmod` after write to handle pre-existing-file case (`writeFile` only honours `mode` on file creation).

Verified by `stat -c %a ~/.frisco-mcp/session.json` after a save → `600`.

## 2. Log file permissions (FIXED)

**Finding.** `src/logger.ts` writes JSONL log lines to `~/.frisco-mcp/logs/<session>.jsonl` and `~/.frisco-mcp/current-session.json` without setting mode. Logs include `outputPreview` slices (first 300 chars of tool output) and full `input` for every tool call. Output previews can include product names/prices but never raw cookies, since cookies never enter the tool result text path.

**Fix.** Patched `src/logger.ts` to chmod logs to `0o600` and dirs to `0o700` on first write per session.

## 3. Outbound destinations

`grep -r 'https?://'` across `src/`:

- All runtime URLs are `frisco.pl` (search, product, cart, checkout, account).
- `README.md` references docs-only URLs (`playwright.dev`, `cheerio.js.org`, `zod.dev`, `typescriptlang.org`, `vitest.dev`) — link text only, never fetched at runtime.

No telemetry, analytics, error-reporting, or third-party API endpoints in code.

## 4. Dependency-tree CVEs

`npm audit --json` before fix:

| Package | Severity | Direct? | Range | Path |
| --- | --- | --- | --- | --- |
| `@hono/node-server` | moderate | no | `<1.19.13` | `@modelcontextprotocol/sdk` → `@hono/node-server` |
| `hono` | moderate | no | `<=4.12.13` | `@modelcontextprotocol/sdk` → `hono` |
| `postcss` | moderate | no | `<8.5.10` | `vitest` → ... → `postcss` |
| `vite` | high | no | `8.0.0 - 8.0.4` | `vitest` → `vite` |

`npm audit fix` (non-breaking) cleared all four. Result: `0 vulnerabilities`. Only `package-lock.json` changed; `package.json` unchanged.

Per audit policy: no critical/high in direct deps, no `@playwright/test` involvement (we use the runtime `playwright` package only), so no blocking findings on dependencies.

## 5. Supply-chain blacklist

Searched the resolved tree against the known-compromised list:

```
event-stream | colors (ASCII art sabotage versions) | faker (boycott versions)
ua-parser-js (compromised 0.7.29/0.8.0/1.0.0) | node-ipc (RIAEvangelist sabotage)
electron-fiddle (compromised installer) | puppeteer-extra-plugin-stealth (ToS-violating)
playwright-extra | puppeteer-stealth-evasions | nodemailer (typosquats)
```

`npm ls --all` returned no matches.

## 6. Stealth/anti-bot dependencies

None present. Frisco runs Cloudflare; introducing fingerprint-evasion would violate ToS and risk Borys's account. The fork uses headed Chromium only (`headless: false` in `src/browser.ts:25`) — already the most-human-like default.

## 7. Licences

All direct deps:

| Package | Version | Licence |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT |
| `cheerio` | 1.2.0 | MIT |
| `playwright` | 1.59.1 | Apache-2.0 |
| `zod` | 3.25.76 | MIT |
| `@types/node` | 22.x | MIT |
| `tsx` | 4.21.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 4.1.2 | MIT |

No GPL/AGPL contamination at the direct-dep layer. Transitives may contain BSD/ISC; not enumerated since this is a personal-use fork and no copyleft surfaced in spot checks.

## 8. Logging hygiene

`src/index.ts::executeTool` logs `input` verbatim and `outputPreview` (first 300 chars). Tool inputs are typically `{query: "mleko"}`, `{items: [...]}`, `{productName: "..."}` — no cookies, no headers, no session tokens. The preview slice does not include cookie data because cookies never enter the tool result text path; `saveSession` writes JSON to disk without going through `executeTool`.

The risk surface here is product-shopping context leakage (queries, prices, names) to anyone with read access to `~/.frisco-mcp/logs`. Mitigated by the file-mode fix above.

## 9. Process hygiene

`src/browser.ts::closeBrowser` wraps `_browser.close()` in `try/catch` that swallows errors, then nulls the handles. If the MCP server is killed with SIGKILL, the Chromium process can survive as a zombie. The `_browser?.isConnected()` check on next `getPage()` correctly detects this and triggers a fresh launch.

Acceptable for personal-use; documented for Phase 2 toolbox deployment so the systemd unit can include `KillMode=mixed` and `KillSignal=SIGTERM` to give the browser teardown a chance.

## 10. Open issues triage (upstream)

The GitHub MCP server in this session is restricted to `borystam/frisco-mcp`; querying `mkidawa/frisco-mcp` is denied. Therefore no live read of upstream open issues / PRs was possible during this audit run.

Action: Borys to manually skim upstream open issues and report back; if any look small and real, file follow-up patches in this fork. Documented in `FORK.md`.

---

## Verdict

**DEPLOY-AFTER-FIXES.**

Two file-mode security fixes (sections 1 and 2) and one transitive-CVE fix (section 4) included in this PR. After those, no critical or high findings remain. Remaining moderate/low items documented and acceptable for a single-user personal-shopping MCP.

Phase 1 work proceeds.
