#!/bin/sh
# Defense-in-depth: isolate the Postgres container (CT 100) with the Proxmox
# firewall so its 5432 is reachable ONLY from the dashboard container (CT 101),
# not from the whole LAN. Idempotent; safe to re-run.
#
#   bash /opt/homelab-agent/deploy/setup-ct-firewall.sh
#
# DESIGN — why this can't lock you out of the host:
#   The cluster firewall is enabled but its policy is set to ACCEPT, so turning
#   the subsystem on does NOT add a default-drop on the Proxmox HOST. The host
#   stays protected by the existing nftables host firewall (nftables-homelab).
#   Only CT 100 gets a per-container DROP policy + an explicit allow for CT 101.
#   CT 101 (the web front-end, meant to be LAN/tailnet reachable) is left open.
#
# REVERT (if the dashboard can't reach the DB): set "enable: 0" in
#   /etc/pve/firewall/100.fw  (or: pct set 100 -net0 <...without firewall=1>)
#   then `systemctl reload pve-firewall`.
set -eu

DASH_IP="${DASH_IP:-192.168.1.21}"   # CT 101 (dashboard) — the only allowed client
PG_CT="${PG_CT:-100}"
LAN="${LAN:-192.168.1.0/24}"

log() { echo ">>> $*"; }

command -v pve-firewall >/dev/null 2>&1 || { echo "pve-firewall not found (run on the Proxmox host)"; exit 1; }

# 1) Cluster firewall ON, but default-ACCEPT so the HOST is unaffected (our
#    nftables host firewall keeps protecting it). Only per-CT rules below bite.
CLUSTER=/etc/pve/firewall/cluster.fw
if [ ! -f "$CLUSTER" ] || ! grep -q '^\s*enable:\s*1' "$CLUSTER"; then
  log "writing $CLUSTER (enable subsystem, policy ACCEPT — host unaffected)"
  cat > "$CLUSTER" <<EOF
[OPTIONS]
enable: 1
policy_in: ACCEPT
policy_out: ACCEPT
EOF
else
  log "cluster firewall already enabled — leaving policy as-is"
fi

# 2) CT 100 rules: drop inbound by default, allow only Postgres from CT 101 and
#    ICMP from the LAN (ping/path-MTU). Established/related is auto-accepted.
PGFW="/etc/pve/firewall/${PG_CT}.fw"
log "writing $PGFW (Postgres reachable only from $DASH_IP)"
cat > "$PGFW" <<EOF
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT

[RULES]
IN ACCEPT -source $DASH_IP -p tcp -dport 5432 -log nolog # Postgres from dashboard (CT 101)
IN ACCEPT -source $LAN -p icmp -log nolog # ping / path-MTU from LAN
EOF

# 3) Enable the per-interface firewall hook on CT 100's net0 (required for the
#    .fw rules to actually apply). Preserve the rest of the net0 config.
net0=$(pct config "$PG_CT" | sed -n 's/^net0: //p')
if [ -z "$net0" ]; then
  log "WARN: could not read net0 for CT $PG_CT — set firewall=1 on its NIC manually"
else
  net0=$(printf '%s' "$net0" | sed 's/,firewall=[01]//')
  log "setting firewall=1 on CT $PG_CT net0"
  pct set "$PG_CT" -net0 "${net0},firewall=1"
fi

# --- Optional: CT 101 (web front-end) -------------------------------------
# OFF by default: CT 101 serves DNS to the whole LAN and the dashboard to
# LAN/tailnet, so a wrong rule is a network-wide outage. Enable with
# INCLUDE_CT101=1. Allows exactly the published service ports + established.
if [ "${INCLUDE_CT101:-0}" = "1" ]; then
  WEB_CT="${WEB_CT:-101}"
  TAILNET="${TAILNET:-100.64.0.0/10}"
  WEBFW="/etc/pve/firewall/${WEB_CT}.fw"
  log "writing $WEBFW (published service ports from LAN + tailnet)"
  cat > "$WEBFW" <<EOF
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: ACCEPT

[RULES]
IN ACCEPT -source $LAN -p udp -dport 53 -log nolog # AdGuard DNS (UDP) — LAN
IN ACCEPT -source $LAN -p tcp -dport 53 -log nolog # AdGuard DNS (TCP) — LAN
IN ACCEPT -source $LAN -p tcp -dport 80 -log nolog # Traefik (HTTP) — LAN
IN ACCEPT -source $TAILNET -p tcp -dport 80 -log nolog # Traefik — tailnet
IN ACCEPT -source $LAN -p tcp -dport 3000 -log nolog # dashboard — LAN
IN ACCEPT -source $TAILNET -p tcp -dport 3000 -log nolog # dashboard — tailnet
IN ACCEPT -source $LAN -p tcp -dport 2222 -log nolog # Forgejo SSH — LAN
IN ACCEPT -source $TAILNET -p tcp -dport 2222 -log nolog # Forgejo SSH — tailnet
IN ACCEPT -source $LAN -p icmp -log nolog # ping / path-MTU — LAN
EOF
  net1=$(pct config "$WEB_CT" | sed -n 's/^net0: //p')
  if [ -n "$net1" ]; then
    net1=$(printf '%s' "$net1" | sed 's/,firewall=[01]//')
    log "setting firewall=1 on CT $WEB_CT net0"
    pct set "$WEB_CT" -net0 "${net1},firewall=1"
  fi
fi

# 4) Compile + reload.
log "compiling firewall ruleset"
pve-firewall compile >/dev/null
systemctl reload pve-firewall 2>/dev/null || pve-firewall restart
sleep 2
log "CT $PG_CT firewall status:"
pve-firewall status || true
log "done. Verify the dashboard still loads (proves CT 101 -> CT 100:5432 works)."
