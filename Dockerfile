# syntax=docker/dockerfile:1.7
#
# Frisco MCP — generic container image for hosted deployment.
#
# Base: Microsoft's official Playwright image — bundles Node.js 20,
# Chromium, and the OS packages the browser needs. Pinned to the same
# Playwright version as in package.json so binary and library agree.
#
# Adds Xvfb + x11vnc + websockify (+ noVNC) so the headed browser can
# run on a server without a display, with optional human access during
# the one-time `login` flow.
#
# This image is generic and contains NO deployment-specific values
# (hosts, ports beyond defaults, tokens, account info). Any wiring goes
# in the consumer's private deployment repo.

ARG PLAYWRIGHT_VERSION=v1.59.0-jammy
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS base

ENV DEBIAN_FRONTEND=noninteractive

# X stack and noVNC bundle. Xvfb is already present on the Playwright
# image but we list it explicitly so the dependency is documented.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        xvfb x11vnc fluxbox tini \
        novnc websockify ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install npm deps first to maximise layer cache hits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

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
