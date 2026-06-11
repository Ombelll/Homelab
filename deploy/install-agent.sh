#!/usr/bin/env bash
#
# install-agent.sh — install/update the Homelab agent as a systemd service.
#
# Idempotent: safe to re-run to pull the latest code, rebuild, and restart.
# Designed for the Proxmox host and any Debian/Ubuntu LXC or VM you want to
# monitor. Run as root.
#
# Usage:
#   DASHBOARD_URL=http://192.168.1.30:3000 AGENT_API_KEY=<key> ./install-agent.sh
#
# Or run with no env and it will prompt for the two required values. If
# /etc/homelab-agent.env already exists, its values are reused unless you pass
# new ones — so a bare re-run just updates code, never clobbers your secret.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Ombelll/Homelab.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/homelab-agent}"
ENV_FILE="/etc/homelab-agent.env"
SERVICE_NAME="homelab-agent"
NODE_MAJOR="${NODE_MAJOR:-20}"

log() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."

# --- 1. Node.js -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "Node.js not found — installing Node ${NODE_MAJOR}.x from NodeSource"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates git
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
else
  # git is still needed for clone/pull even when node is present.
  command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }
fi
log "Node $(node --version), npm $(npm --version)"

# --- 2. Code ----------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin
  # Resolve the remote default branch (don't assume main vs master).
  default_branch="$(git -C "$INSTALL_DIR" remote show origin \
    | sed -n 's/.*HEAD branch: //p')"
  git -C "$INSTALL_DIR" reset --hard --quiet "origin/${default_branch:-main}"
else
  log "Cloning $REPO_URL → $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

# --- 3. Build ---------------------------------------------------------------
log "Installing agent dependencies and building"
cd "$INSTALL_DIR/agent"
npm ci --silent
npm run build --silent
[ -f dist/index.js ] || die "build did not produce dist/index.js"

# --- 4. Environment file (0600, never logged) -------------------------------
# Reuse existing values unless overridden by env vars passed to this script.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
: "${DASHBOARD_URL:=}"
: "${AGENT_API_KEY:=}"

if [ -z "$DASHBOARD_URL" ]; then
  read -rp "Dashboard URL (e.g. http://192.168.1.30:3000): " DASHBOARD_URL
fi
if [ -z "$AGENT_API_KEY" ]; then
  read -rsp "Agent API key (X-Agent-Key, must match the dashboard): " AGENT_API_KEY
  echo
fi
[ -n "$DASHBOARD_URL" ] || die "DASHBOARD_URL is required."
[ -n "$AGENT_API_KEY" ] || die "AGENT_API_KEY is required."

umask 077
cat > "$ENV_FILE" <<EOF
DASHBOARD_URL=${DASHBOARD_URL}
AGENT_API_KEY=${AGENT_API_KEY}
# Optional: friendly name shown in the dashboard (defaults to hostname)
AGENT_SERVER_NAME=${AGENT_SERVER_NAME:-$(hostname)}
# Optional: metrics interval in seconds (default 30, minimum 5)
AGENT_INTERVAL_SECONDS=${AGENT_INTERVAL_SECONDS:-30}
EOF

# Preserve optional integration settings across re-runs. These aren't prompted
# (so the base heredoc above doesn't know them), but they live in $ENV_FILE and
# were sourced in step 4 — re-emit any that are set so a code update never wipes
# SNMP polling / UPS / backup config. (Bug fix: a bare re-run used to drop them.)
for _var in AGENT_SNMP_TARGET AGENT_SNMP_COMMUNITY AGENT_BACKUP_DIR \
            AGENT_REQUEST_TIMEOUT_SECONDS AGENT_UPS_NAME AGENT_ROUTER_SSH \
            AGENT_SPEEDTEST_CONTAINER; do
  _val="${!_var:-}"
  [ -n "$_val" ] && printf '%s=%s\n' "$_var" "$_val" >> "$ENV_FILE"
done

chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
log "Wrote $ENV_FILE (0600) — secret not echoed"

# --- 5. systemd service -----------------------------------------------------
install -m 0644 "$INSTALL_DIR/deploy/${SERVICE_NAME}.service" \
  "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

log "Done. Follow logs with:  journalctl -u ${SERVICE_NAME} -f"
sleep 2
systemctl --no-pager --full status "$SERVICE_NAME" | head -n 12 || true
