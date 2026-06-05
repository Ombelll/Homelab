#!/bin/sh
# Back up the PROXMOX HOST's own configuration. vzdump backs up the guests, not
# the PVE host root filesystem — so the firewall ruleset, cron jobs, agent &
# backup env files, NUT/UPS config, network and storage config live ONLY on the
# host's NVMe. If that disk dies you'd rebuild all of it from memory. This tars
# the important /etc paths to tank (a SEPARATE physical disk), so an NVMe death
# doesn't take the config with it.
#
#   30 3 * * *  /opt/homelab-agent/deploy/host-config-backup.sh >> /var/log/host-config-backup.log 2>&1
#
# NOTE: the tarball contains secrets (agent key, backup env). It lands on tank
# (same trust domain as the host) and — if you point the offsite sync at
# /tank/backups — goes offsite ENCRYPTED via the existing rclone crypt remote.
#
# Config (optional) in /etc/host-config-backup.env:
#   DEST=/tank/backups/host-config
#   KEEP=14
#   HC_PING_URL=https://hc-ping.com/<uuid>
set -eu

LOG=/var/log/host-config-backup.log
[ -f /etc/host-config-backup.env ] && . /etc/host-config-backup.env
DEST="${DEST:-/tank/backups/host-config}"
KEEP="${KEEP:-14}"
HC="${HC_PING_URL:-}"

log() { echo "$(date -Is) $*" >> "$LOG"; }
hc() {
  [ -n "$HC" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  if [ "${1:-}" = "/fail" ]; then
    tail -n 20 "$LOG" 2>/dev/null | curl -fsS -m 10 --data-binary @- -o /dev/null "${HC}/fail" || true
  else
    curl -fsS -m 10 -o /dev/null "${HC}${1:-}" || true
  fi
}
fail() { log "FAILED: $*"; hc /fail; exit 1; }

# The paths worth keeping. Pseudo-fs /etc/pve (pmxcfs) is readable and holds the
# cluster/firewall/guest config. Missing paths are skipped, not fatal.
PATHS="
/etc/pve/firewall
/etc/pve/lxc
/etc/pve/storage.cfg
/etc/pve/jobs.cfg
/etc/pve/user.cfg
/etc/nftables-homelab.nft
/etc/network/interfaces
/etc/hosts
/etc/resolv.conf
/etc/cron.d
/etc/cron.daily
/etc/fstab
/etc/fail2ban
/etc/nut
/etc/systemd/system/homelab-agent.service
/etc/homelab-agent.env
/etc/pg-backup.env
/etc/host-config-backup.env
/etc/offsite-backup.env
/etc/apt/sources.list
/etc/apt/sources.list.d
/etc/sysctl.d
"

hc /start
mkdir -p "$DEST"
ts=$(date +%Y%m%d-%H%M%S)
out="$DEST/host-config-${ts}.tar.gz"

# Only include paths that exist.
set --
for p in $PATHS; do [ -e "$p" ] && set -- "$@" "$p"; done
[ "$#" -gt 0 ] || fail "no config paths found to back up"

log "archiving $# paths -> $out"
# --ignore-failed-read: a transient unreadable file shouldn't abort the lot.
if tar czf "$out" --ignore-failed-read -- "$@" 2>>"$LOG"; then
  chmod 600 "$out"
  size=$(wc -c < "$out")
  [ "$size" -ge 512 ] || fail "archive suspiciously small ($size bytes)"
  log "host-config archive OK ($size bytes)"
else
  fail "tar failed"
fi

# Retention: keep newest $KEEP archives.
ls -1t "$DEST"/host-config-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true

log "host-config-backup complete"
hc
