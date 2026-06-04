#!/bin/sh
# One-command homelab deploy — run on the Proxmox host (as root).
#
#   bash /opt/homelab-agent/deploy/deploy.sh
#
# Rebuilds the dashboard (CT 101) to the latest main and updates the agents on
# the host + each Linux CT. Replaces the manual pct-exec dance. Windows agents
# (PC/laptop) update themselves via the dashboard's agent.update job.
set -eu

DASH_CT="${DASH_CT:-101}"
DASH_DIR="${DASH_DIR:-/opt/Homelab}"
AGENT="${AGENT:-/opt/homelab-agent/deploy/install-agent.sh}"
AGENT_CTS="${AGENT_CTS:-100 101}"
COMPOSE="-f docker-compose.yml -f deploy/docker-compose.labels.yml"

log() { echo ">>> $*"; }

log "Rebuilding dashboard in CT $DASH_CT (git pull + compose up --build)…"
pct exec "$DASH_CT" -- bash -c \
  "cd $DASH_DIR && git pull --no-edit -q && docker compose $COMPOSE up -d --build" 2>&1 | tail -5

# Host agent (if installed on the host itself, e.g. Proxmox). Check for the
# file, not the executable bit — git checkouts on some platforms drop +x, which
# would silently skip the agent refresh (and the host-side deploy scripts).
if [ -f "$AGENT" ]; then
  log "Updating host agent…"
  if bash "$AGENT" >/dev/null 2>&1; then log "  host agent OK"; else log "  host agent FAILED"; fi
fi

# Agent inside each Linux CT that has the installer.
for ct in $AGENT_CTS; do
  if pct exec "$ct" -- test -f "$AGENT" 2>/dev/null; then
    log "Updating agent in CT $ct…"
    if pct exec "$ct" -- bash "$AGENT" >/dev/null 2>&1; then log "  CT $ct agent OK"; else log "  CT $ct agent FAILED"; fi
  fi
done

log "Deploy complete."
