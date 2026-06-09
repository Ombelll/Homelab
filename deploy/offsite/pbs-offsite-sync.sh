#!/usr/bin/env bash
# Encrypted off-site sync of the PBS datastore to a cloud remote via rclone.
#
# Runs ON the PBS host (node 2, Proxmox-02), where the datastore lives at
# /bkp/datastore. The datastore holds *every* guest backup (CT100/101/110 + any
# future ones), so mirroring it off-site covers the whole homelab in one go.
#
# Encryption is client-side: RCLONE_REMOTE points at an rclone `crypt` remote
# that wraps your off-site remote (Hetzner Storage Box over SFTP here; B2/S3/etc.
# work too), so filenames AND contents are encrypted before they leave the
# house. The crypt password is the DR key —
# without it the off-site copy is useless, so store it somewhere safe
# (Vaultwarden) and OFF the homelab. See deploy/fase-11-offsite-backup.md.
#
# Config via env (defaults shown), e.g. from /etc/pbs-offsite.env:
#   PBS_DATASTORE   source dir            (default /bkp/datastore)
#   RCLONE_REMOTE   destination remote    (default offsite-crypt:pbs)
#   RCLONE_BWLIMIT  upload cap, e.g. 20M  (default 0 = unlimited)
#   MAX_DELETE      safety cap on deletions per run (default 5000)
set -euo pipefail

[ -f /etc/pbs-offsite.env ] && . /etc/pbs-offsite.env

SRC="${PBS_DATASTORE:-/bkp/datastore}"
REMOTE="${RCLONE_REMOTE:-offsite-crypt:pbs}"
BWLIMIT="${RCLONE_BWLIMIT:-0}"
MAX_DELETE="${MAX_DELETE:-5000}"
LOG="${PBS_OFFSITE_LOG:-/var/log/pbs-offsite-sync.log}"
LOCK="/run/pbs-offsite-sync.lock"

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

# Don't overlap with a previous (slow) run.
exec 9>"$LOCK"
flock -n 9 || { log "another sync is already running, skipping"; exit 0; }

# Safety: never let an empty/unmounted source nuke the off-site copy.
if [ ! -d "$SRC" ] || [ -z "$(ls -A "$SRC" 2>/dev/null)" ]; then
  log "ERROR: source '$SRC' missing or empty — aborting (refusing to sync nothing)"
  exit 1
fi

log "=== off-site sync start: $SRC -> $REMOTE (bwlimit=$BWLIMIT) ==="
rc=0
rclone sync "$SRC" "$REMOTE" \
  --transfers 8 --checkers 16 --fast-list \
  --bwlimit "$BWLIMIT" \
  --max-delete "$MAX_DELETE" \
  --log-file "$LOG" --log-level INFO --stats 5m --stats-one-line || rc=$?

if [ "$rc" -eq 0 ]; then
  log "=== off-site sync OK ==="
else
  log "=== off-site sync FAILED (rclone rc=$rc) ==="
fi
exit "$rc"
