#!/bin/sh
# Off-site mirror of the PBS datastore (node 2 / Proxmox-02) to the Hetzner
# Storage Share, end-to-end encrypted (rclone crypt over webdav).
#
# The PBS datastore (/bkp/datastore) holds EVERY guest backup the cluster makes
# (CT100/101 + CT110 + any future), so this is the off-site copy for node-2 data
# AND a second off-site copy of everything. Companion to node 1's
# deploy/offsite-backup.sh; it writes to a SEPARATE crypt folder
# (offsite:pbs-node2) so the two nodes never overwrite each other, and it reuses
# the SAME rclone remotes (so one DR crypt key covers everything).
#
# Requires rclone >= 1.63 (Nextcloud chunked upload — older rclone 413s on big
# chunk files). DORMANT until the "offsite" remote exists on this host.
set -eu

LOG=/var/log/offsite-backup-pbs.log
SRC=/bkp/datastore
REMOTE=offsite:pbs-node2

# Optional healthchecks.io dead-man's switch (own check for node 2), kept OFF
# git: /etc/offsite-backup-pbs.env  ->  HC_PING_URL="https://hc-ping.com/<uuid>"
[ -f /etc/offsite-backup-pbs.env ] && . /etc/offsite-backup-pbs.env
HC_PING_URL="${HC_PING_URL:-}"

log() { echo "$(date -Is) $*" >> "$LOG"; }
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
command -v rclone >/dev/null 2>&1 || { log "rclone not installed; skipping"; hc /fail; exit 0; }
rclone listremotes 2>/dev/null | grep -q '^offsite:' \
  || { log "offsite remote not configured; skipping (copy node 1's rclone.conf)"; hc /fail; exit 0; }
# Safety: never mirror an empty/unmounted datastore over the good off-site copy.
{ [ -d "$SRC" ] && [ -n "$(ls -A "$SRC" 2>/dev/null)" ]; } \
  || { log "source $SRC missing/empty; aborting"; hc /fail; exit 1; }

log "starting offsite PBS sync $SRC -> $REMOTE"
if rclone sync "$SRC" "$REMOTE" \
    --transfers 4 --checkers 8 --fast-list \
    --webdav-nextcloud-chunk-size 32M \
    --log-file "$LOG" --log-level INFO; then
  log "offsite PBS sync OK"
  hc
else
  rc=$?
  log "offsite PBS sync FAILED (exit $rc)"
  hc /fail
  exit 1
fi
