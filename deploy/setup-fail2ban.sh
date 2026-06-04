#!/bin/sh
# Install + configure fail2ban to ban IPs that brute-force SSH on the Proxmox
# host. Idempotent — safe to re-run. Run on the HOST (where sshd lives), as root:
#
#   bash /opt/homelab-agent/deploy/setup-fail2ban.sh
#
# Complements the nftables host firewall: the firewall controls WHICH ports are
# reachable; fail2ban temporarily blocks hosts that hammer the SSH port with
# failed logins (the kex_exchange_identification noise you saw in the journal).
#
# On Proxmox/Debian sshd logs to the journal, so we use the systemd backend.
set -eu

log() { echo ">>> $*"; }

if ! command -v fail2ban-server >/dev/null 2>&1; then
  log "installing fail2ban…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq fail2ban
else
  log "fail2ban already installed"
fi

# Local jail override (never edit jail.conf directly — it's package-managed).
JAIL=/etc/fail2ban/jail.d/sshd.local
log "writing $JAIL"
cat > "$JAIL" <<'EOF'
[sshd]
enabled  = true
port     = ssh
backend  = systemd
maxretry = 4
findtime = 10m
bantime  = 1h
# Escalate repeat offenders: each re-ban lasts longer.
bantime.increment = true
EOF

# Make sure ssh keys / your own LAN aren't lockout-prone: ignore localhost +
# the LAN + the tailnet so a fat-fingered password from your own machine can't
# lock you out. Adjust if your subnets differ.
IGNORE=/etc/fail2ban/jail.d/ignoreip.local
cat > "$IGNORE" <<'EOF'
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 192.168.1.0/24 100.64.0.0/10
EOF

log "enabling + starting fail2ban"
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban

sleep 2
log "status:"
fail2ban-client status sshd || log "  (jail not up yet — check: journalctl -u fail2ban)"
log "done."
