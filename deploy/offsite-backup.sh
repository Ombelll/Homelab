#!/bin/sh
# Offsite backup — encrypted mirror of the local Proxmox vzdump archives to the
# Hetzner Storage Share (managed Nextcloud) via rclone.
#
# Topology:  /tank/backups/dump  --rclone sync-->  offsite:  (crypt over webdav)
# The "offsite" rclone remote is a `crypt` remote wrapping a `webdav` remote, so
# both file CONTENTS and NAMES are encrypted before they leave the host — the
# provider only ever sees ciphertext.
#
# DORMANT until the "offsite" remote exists (see deploy/offsite-backup.md for
# the one-time `rclone config` step). Until then this exits 0 and does nothing,
# so the cron is safe to install ahead of time.
#
# vzdumps are full CT/VM backups (they already contain CT100 Postgres + the
# pg_dumps + CT101's Docker volumes), so mirroring that one directory gives a
# complete offsite restore point. Local retention (vzdump prune: keep-daily 14)
# bounds the size; `rclone sync` mirrors deletions too, so offsite tracks it.
set -eu

LOG=/var/log/offsite-backup.log
SRC=/tank/backups/dump
DST=offsite:vzdump

# Optional config (kept OFF git — this is a public repo). The host stores the
# healthchecks.io dead-man's-switch URL here, 0600:
#   /etc/offsite-backup.env  ->  HC_PING_URL="https://hc-ping.com/<uuid>"
if [ -f /etc/offsite-backup.env ]; then
  . /etc/offsite-backup.env
fi
HC_PING_URL="${HC_PING_URL:-}"

log() { echo "$(date -Is) $*" >> "$LOG"; }

# healthchecks.io ping. $1 = "" (success) | "/start" | "/fail". Best-effort —
# a ping failure must never break or fail the backup. On /fail we attach the
# tail of the log so the alert email shows why.
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

hc /start

if ! command -v rclone >/dev/null 2>&1; then
  log "rclone not installed; skipping"
  hc /fail
  exit 0
fi
if ! rclone listremotes 2>/dev/null | grep -q '^offsite:'; then
  log "offsite remote not configured yet; skipping (see deploy/offsite-backup.md)"
  hc /fail
  exit 0
fi
if [ ! -d "$SRC" ]; then
  log "source $SRC missing; skipping"
  hc /fail
  exit 0
fi

log "starting offsite sync $SRC -> $DST"
# --transfers/-checkers conservative for a home uplink; bump if you have headroom.
if rclone sync "$SRC" "$DST" \
  --transfers 2 --checkers 4 \
  --log-file "$LOG" --log-level INFO; then
  log "offsite sync OK"
  hc            # success ping — resets the dead-man's-switch timer
else
  rc=$?
  log "offsite sync FAILED (exit $rc)"
  hc /fail
  exit 1
fi
