# syntax=docker/dockerfile:1.7
#
# Frisco MCP — generic container image for hosted deployment.
#
# Two-stage build atop `node:20-slim`. Stage 1 compiles TypeScript
# and prunes dev deps; Stage 2 takes the slim node base, installs
# only the system libs Chromium needs (via the upstream-blessed
# `playwright install --with-deps chromium`), the X stack for headed
# mode on a server, and copies the pre-built artefacts from the
# builder. The full Playwright Docker image (which ships Firefox +
# WebKit + dev deps) is avoided entirely — the result is roughly
# half the size and well under the 2 GB CI budget.
#
# This image is generic and contains NO deployment-specific values
# (hosts, ports beyond defaults, tokens, account info). Any wiring
# goes in the consumer's private deployment repo.

# ── Stage 1: builder ───────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install npm deps first to maximise layer cache hits.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ── Stage 2: runtime ───────────────────────────────────────────────
FROM node:20-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Unprivileged runtime user. Created up front so the chromium cache
# created below ends up owned by it.
RUN groupadd --system pwuser \
 && useradd --system --gid pwuser --create-home --shell /bin/bash pwuser

WORKDIR /app

# Copy production node_modules + dist + manifest from the builder
# stage. Source files (src/, tsconfig.json) and dev deps (typescript,
# vitest, tsx, @types/node) stay behind in the builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

# X stack + tini + ca-certs + chromium (with system libs).
# `playwright install --with-deps chromium` is the upstream-blessed
# way to install only what the browser needs — the Playwright base
# image preinstalls all three browsers (Firefox + WebKit + Chromium)
# plus their full dependency closure, which is nearly 2 GB on its
# own. This installs only chromium and its required shared libs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        xvfb x11vnc fluxbox tini \
        novnc websockify ca-certificates \
 && npx --yes playwright install --with-deps chromium \
 && chown -R pwuser:pwuser /ms-playwright /app \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
           /root/.npm /root/.cache \
           /usr/share/doc /usr/share/man /usr/share/locale

# Cookie/log mount-point + X socket dir.
RUN mkdir -p /home/pwuser/.frisco-mcp /tmp/.X11-unix \
 && chown -R pwuser:pwuser /home/pwuser \
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
