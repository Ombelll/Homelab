#!/bin/sh
# Nightly LOGICAL Postgres backup of the shared database in CT 100.
#
# Why, on top of the vzdump CT backup? A vzdump is a whole-container image —
# great for disaster recovery, clumsy when you just want to restore one table
# or inspect last week's data. A `pg_dump` custom-format archive restores
# selectively with `pg_restore` and is portable across Postgres hosts.
#
# Topology:
#   pg_dump (inside CT 100)  ->  /var/backups/postgres/<db>-<ts>.dump   (in the CT)
#                            \->  /tank/backups/pg/<db>-<ts>.dump        (on the host, ZFS)
# The in-CT copy is captured by the daily CT 100 vzdump (and thus the offsite
# mirror); the tank copy is for instant local restore without unpacking a vzdump.
#
# Run on the Proxmox host as root, e.g. nightly before the vzdump window:
#   15 2 * * *  /opt/homelab-agent/deploy/pg-backup.sh >> /var/log/pg-backup.log 2>&1
#
# Config (optional, kept OFF git — public repo) in /etc/pg-backup.env (0600):
#   PG_CT=100
#   PG_DB=homelab            # the database the dashboard uses
#   PG_USER=postgres
#   IN_CT_DIR=/var/backups/postgres
#   TANK_DIR=/tank/backups/pg   # set empty to skip the host copy
#   KEEP=14                  # how many dumps to retain (per location)
#   HC_PING_URL=https://hc-ping.com/<uuid>   # optional dead-man's switch
#
# RESTORE (example — into a scratch DB to inspect, never straight over prod):
#   createdb -U postgres homelab_restore
#   pg_restore -U postgres -d homelab_restore /tank/backups/pg/homelab-YYYY...dump
set -eu

LOG=/var/log/pg-backup.log

[ -f /etc/pg-backup.env ] && . /etc/pg-backup.env
PG_CT="${PG_CT:-100}"
PG_DB="${PG_DB:-homelab}"
PG_USER="${PG_USER:-postgres}"
IN_CT_DIR="${IN_CT_DIR:-/var/backups/postgres}"
TANK_DIR="${TANK_DIR:-/tank/backups/pg}"
KEEP="${KEEP:-14}"
HC_PING_URL="${HC_PING_URL:-}"

log() { echo "$(date -Is) $*" >> "$LOG"; }

# healthchecks.io ping. $1 = "" (success) | "/start" | "/fail". Best-effort.
hc() {
  [ -n "$HC_PING_URL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  if [ "${1:-}" = "/fail" ]; then
    tail -n 20 "$LOG" 2>/dev/null \
      | curl -fsS -m 10 --retry 3 --data-binary @- -o /dev/null "${HC_PING_URL}/fail" || true
  else
    curl -fsS -m 10 --retry 3 -o /dev/null "${HC_PING_URL}${1:-}" || true
  fi
}

fail() { log "FAILED: $*"; hc /fail; exit 1; }

hc /start

command -v pct >/dev/null 2>&1 || fail "pct not found (run on the Proxmox host)"
pct status "$PG_CT" 2>/dev/null | grep -q running || fail "CT $PG_CT not running"

ts=$(date +%Y%m%d-%H%M%S)
fname="${PG_DB}-${ts}.dump"
inct="$IN_CT_DIR/$fname"

log "dumping $PG_DB from CT $PG_CT -> $inct"

# Make the target dir inside the CT and let the postgres role own it.
pct exec "$PG_CT" -- mkdir -p "$IN_CT_DIR" || fail "mkdir $IN_CT_DIR in CT"
pct exec "$PG_CT" -- chown "$PG_USER" "$IN_CT_DIR" 2>/dev/null || true

# pg_dump custom format (-Fc): compressed, selective-restore capable. Run as the
# postgres role via peer auth, so no password is needed or stored.
if ! pct exec "$PG_CT" -- su -l "$PG_USER" -c "pg_dump -Fc -f '$inct' '$PG_DB'"; then
  fail "pg_dump returned non-zero"
fi

# Sanity: a real dump is never a few bytes. Guards against a silent empty dump.
size=$(pct exec "$PG_CT" -- stat -c %s "$inct" 2>/dev/null || echo 0)
[ "$size" -ge 1000 ] || fail "dump suspiciously small ($size bytes)"
log "dump OK ($size bytes)"

# Optional host copy onto tank (ZFS) for instant restore.
if [ -n "$TANK_DIR" ]; then
  mkdir -p "$TANK_DIR"
  if pct pull "$PG_CT" "$inct" "$TANK_DIR/$fname" 2>>"$LOG"; then
    log "copied to $TANK_DIR/$fname"
  else
    log "WARN: pct pull to tank failed (in-CT dump still made it)"
  fi
fi

# Retention: keep the newest $KEEP dumps in each location.
# In-CT prune
pct exec "$PG_CT" -- sh -c \
  "ls -1t '$IN_CT_DIR'/${PG_DB}-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f" \
  2>>"$LOG" || true
# Tank prune
if [ -n "$TANK_DIR" ] && [ -d "$TANK_DIR" ]; then
  ls -1t "$TANK_DIR"/${PG_DB}-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true
fi

log "pg-backup complete"
hc
