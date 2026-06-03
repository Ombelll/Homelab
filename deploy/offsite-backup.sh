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

log() { echo "$(date -Is) $*" >> "$LOG"; }

if ! command -v rclone >/dev/null 2>&1; then
  log "rclone not installed; skipping"
  exit 0
fi
if ! rclone listremotes 2>/dev/null | grep -q '^offsite:'; then
  log "offsite remote not configured yet; skipping (see deploy/offsite-backup.md)"
  exit 0
fi
if [ ! -d "$SRC" ]; then
  log "source $SRC missing; skipping"
  exit 0
fi

log "starting offsite sync $SRC -> $DST"
# --transfers/-checkers conservative for a home uplink; bump if you have headroom.
if rclone sync "$SRC" "$DST" \
  --transfers 2 --checkers 4 \
  --log-file "$LOG" --log-level INFO; then
  log "offsite sync OK"
else
  log "offsite sync FAILED (exit $?)"
  exit 1
fi
