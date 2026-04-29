# syntax=docker/dockerfile:1.7
#
# Frisco MCP — generic container image for hosted deployment.
#
# Two-stage build:
#   1. builder — Microsoft's Playwright base; installs all npm deps
#      (incl. dev), compiles TypeScript, prunes dev deps.
#   2. runtime — same Playwright base, with the X stack added and the
#      unused Playwright browsers (Firefox, WebKit, bundled ffmpeg)
#      stripped. Compiled output and pruned node_modules are copied
#      from the builder.
#
# Why the same base on both sides: native bindings (e.g. anything that
# resolves to a glibc-pinned binary) only need to match once because
# only one base is pulled. The build-time Playwright + dev deps stay
# in the builder layer and never reach the published image.
#
# The image is generic and contains NO deployment-specific values
# (hosts, ports beyond defaults, tokens, account info). Any wiring
# goes in the consumer's private deployment repo.

ARG PLAYWRIGHT_VERSION=v1.59.0-jammy

# ── Stage 1: builder ───────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS builder

WORKDIR /app

# Install npm deps first to maximise layer cache hits.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ── Stage 2: runtime ───────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# X stack and noVNC bundle. Xvfb is already present on the Playwright
# image but we list it explicitly so the dependency is documented.
# Strip Firefox / WebKit / bundled ffmpeg from the Playwright cache —
# the app only uses Chromium (see src/browser.ts). This is the
# largest single win on image size.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        xvfb x11vnc fluxbox tini \
        novnc websockify ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && find /ms-playwright -mindepth 1 -maxdepth 1 -type d \
        \( -iname 'firefox*' -o -iname 'webkit*' -o -iname 'ffmpeg*' \) \
        -exec rm -rf {} +

WORKDIR /app

# Compiled output and pruned (production-only) node_modules from the
# builder stage. Source files (src/, tsconfig.json) and dev deps stay
# behind in the builder and never reach the published image.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Drop into the unprivileged "pwuser" account that the Playwright image
# already provisions; it owns the browser cache directory.
RUN mkdir -p /home/pwuser/.frisco-mcp /tmp/.X11-unix \
 && chown -R pwuser:pwuser /app /home/pwuser/.frisco-mcp \
 && chmod 700 /home/pwuser/.frisco-mcp \
 && chmod 1777 /tmp/.X11-unix

COPY docker/entrypoint.sh /usr/local/bin/frisco-mcp-entrypoint
RUN chmod +x /usr/local/bin/frisco-mcp-entrypoint

USER pwuser
# Bind 0.0.0.0 inside the container so docker port-forwarding can
# reach it from the host. The host-side publish (compose / `docker
# run -p`) is what actually scopes external access — keep that on
# loopback (127.0.0.1:PORT:PORT) unless you also gate behind a bearer.
ENV HOME=/home/pwuser \
    DISPLAY=:99 \
    NOVNC_PORT=6080 \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3031

EXPOSE 3031 6080

VOLUME ["/home/pwuser/.frisco-mcp"]

# Healthcheck: probe /healthz only — never hits Frisco, so a network
# blip upstream does not flap the container's health state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.MCP_HTTP_PORT||3031) +'/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/frisco-mcp-entrypoint"]
