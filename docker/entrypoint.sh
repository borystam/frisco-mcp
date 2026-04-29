#!/usr/bin/env bash
# Container entrypoint.
#
# Boots an Xvfb display, an x11vnc server bound to loopback, websockify
# (so noVNC can proxy in), then exec's the MCP server. PID 1 is `tini`,
# so signals propagate cleanly to all children.
#
# The noVNC port is bound to all interfaces inside the container; the
# consumer's compose / orchestration layer publishes (or doesn't)
# the host-side port. There are NO deployment-specific assumptions
# baked in here.

set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
SCREEN_GEOM="${FRISCO_MCP_SCREEN:-1280x800x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
X11VNC_PORT="${X11VNC_PORT:-5900}"
NOVNC_BIND="${NOVNC_BIND:-0.0.0.0}"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# Clean up stale lock files from a previous run. `docker compose restart`
# reuses the container's filesystem; if the previous Xvfb left a lockfile
# behind, the new one refuses to start with "Server is already active".
DISPLAY_NUM=${DISPLAY#:}
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

# Xvfb display
log "starting Xvfb on ${DISPLAY} (${SCREEN_GEOM})"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOM}" -nolisten tcp -dpi 96 +extension RANDR &
XVFB_PID=$!

# Wait briefly for the display socket.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ]; then break; fi
  sleep 0.2
done

# Optional minimal window manager (fluxbox); makes some pages render
# slightly more cooperatively when modal dialogs need to be focusable.
fluxbox -display "${DISPLAY}" >/dev/null 2>&1 &
FLUXBOX_PID=$!

# x11vnc — bound to loopback. The noVNC proxy publishes outwards.
# Password handling: if X11VNC_PASSWORD is set, use it; otherwise run
# without a password but only listen on loopback so noVNC is the only
# entry point.
log "starting x11vnc on 127.0.0.1:${X11VNC_PORT}"
if [ -n "${X11VNC_PASSWORD:-}" ]; then
  x11vnc -display "${DISPLAY}" -rfbport "${X11VNC_PORT}" \
    -localhost -shared -forever -bg -o /tmp/x11vnc.log \
    -passwd "${X11VNC_PASSWORD}"
  unset X11VNC_PASSWORD
else
  x11vnc -display "${DISPLAY}" -rfbport "${X11VNC_PORT}" \
    -localhost -shared -forever -bg -o /tmp/x11vnc.log -nopw
fi

# noVNC over websockify.
log "starting websockify on ${NOVNC_BIND}:${NOVNC_PORT} -> 127.0.0.1:${X11VNC_PORT}"
websockify --web=/usr/share/novnc/ \
  "${NOVNC_BIND}:${NOVNC_PORT}" "127.0.0.1:${X11VNC_PORT}" >/tmp/websockify.log 2>&1 &
WEBSOCKIFY_PID=$!

cleanup() {
  log "shutting down (signal=$1)"
  # Ask Node to exit cleanly first; it has its own SIGTERM handling
  # with a 10 s budget.
  if [ -n "${NODE_PID:-}" ] && kill -0 "${NODE_PID}" 2>/dev/null; then
    kill -TERM "${NODE_PID}" 2>/dev/null || true
    # tini will reap when Node exits.
  fi
  for pid in "${WEBSOCKIFY_PID:-}" "${FLUXBOX_PID:-}" "${XVFB_PID:-}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
}
trap 'cleanup TERM' TERM
trap 'cleanup INT' INT

log "starting MCP server (transport=${MCP_TRANSPORT:-http})"
node /app/dist/index.js &
NODE_PID=$!
wait "${NODE_PID}"
RC=$?
cleanup EXIT
exit "${RC}"
