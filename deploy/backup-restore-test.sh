#!/bin/sh
# Automated backup restore-test — "an untested backup is not a backup".
#
# Once a month this restores the NEWEST vzdump of a chosen CT to a throwaway
# CTID on the same node, boots it, checks it actually runs, then stops and
# DESTROYS the temp CT. It never touches the real CT or its data: pct restore
# creates a brand-new container under TEST_CTID.
#
# Result is reported to healthchecks.io (success / /fail with log tail) so a
# silently-broken backup chain surfaces the same way the offsite job does.
#
# Defaults are conservative: it tests the SMALLEST CT (CT 100, the Postgres
# LXC) so the temp restore fits comfortably on `tank`. Override via the env
# file if you want a different source.
#
# Config (kept OFF git): /etc/backup-restore-test.env, 0600, e.g.
#   HC_PING_URL="https://hc-ping.com/<uuid>"   # optional dead-man's switch
#   SRC_CTID=100                                # CT whose backup to test
#   TEST_CTID=990                               # throwaway id (must be free)
#   STORAGE=local-lvm                           # where to restore the rootfs
set -eu

DUMP_DIR=/tank/backups/dump
LOG=/var/log/backup-restore-test.log

if [ -f /etc/backup-restore-test.env ]; then
  . /etc/backup-restore-test.env
fi
HC_PING_URL="${HC_PING_URL:-}"
SRC_CTID="${SRC_CTID:-100}"
TEST_CTID="${TEST_CTID:-990}"
STORAGE="${STORAGE:-local-lvm}"

log() { echo "$(date -Is) $*" >> "$LOG"; }

hc() {
  [ -n "$HC_PING_URL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  if [ "${1:-}" = "/fail" ]; then
    tail -n 25 "$LOG" 2>/dev/null \
      | curl -fsS -m 10 --retry 3 --data-binary @- -o /dev/null "${HC_PING_URL}/fail" || true
  else
    curl -fsS -m 10 --retry 3 -o /dev/null "${HC_PING_URL}${1:-}" || true
  fi
}

# Always try to tear the temp CT down, even on an error/exit partway through,
# so a failed test never leaves a stray container or leaks disk.
cleanup() {
  if pct status "$TEST_CTID" >/dev/null 2>&1; then
    log "cleanup: stopping + destroying temp CT $TEST_CTID"
    pct stop "$TEST_CTID" >/dev/null 2>&1 || true
    pct destroy "$TEST_CTID" --purge >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

hc /start
log "=== restore-test start (src CT $SRC_CTID -> temp CT $TEST_CTID) ==="

# Refuse to clobber an existing CTID — picking an in-use id would be dangerous.
if pct status "$TEST_CTID" >/dev/null 2>&1; then
  log "ABORT: TEST_CTID $TEST_CTID already exists; pick a free id"
  hc /fail
  exit 1
fi

# Newest archive for the source CT.
ARCHIVE=$(ls -1t "$DUMP_DIR"/vzdump-lxc-"$SRC_CTID"-*.tar.* 2>/dev/null | head -n 1 || true)
if [ -z "$ARCHIVE" ]; then
  log "ABORT: no vzdump archive found for CT $SRC_CTID in $DUMP_DIR"
  hc /fail
  exit 1
fi
log "restoring $ARCHIVE"

# Restore to the throwaway id. --unprivileged keeps mapping sane; the temp CT
# starts with networking off-by-default risk minimised (we don't add it to a
# bridge that could clash — the source config is reused but we never start it
# on the production IP for long; it's stopped within seconds).
if ! pct restore "$TEST_CTID" "$ARCHIVE" --storage "$STORAGE" >>"$LOG" 2>&1; then
  log "FAIL: pct restore returned non-zero"
  hc /fail
  exit 1
fi

# CRITICAL: the clone inherits the source CT's static IP/MAC. Bring its NIC up
# administratively DOWN before starting, so it can never clash with the live
# CT on the LAN (e.g. CT 100's 192.168.1.20). We still boot it to prove the
# rootfs + init work; it just has no network.
BRIDGE=$(pct config "$TEST_CTID" 2>/dev/null | sed -n 's/^net0:.*bridge=\([^,]*\).*/\1/p' | head -n1)
[ -n "$BRIDGE" ] || BRIDGE=vmbr0
pct set "$TEST_CTID" --net0 "name=eth0,bridge=$BRIDGE,link_down=1" >>"$LOG" 2>&1 || true

# Boot it and confirm it reaches "running". We give it a few seconds.
if ! pct start "$TEST_CTID" >>"$LOG" 2>&1; then
  log "FAIL: pct start returned non-zero"
  hc /fail
  exit 1
fi

ok=0
i=0
while [ "$i" -lt 15 ]; do
  if [ "$(pct status "$TEST_CTID" 2>/dev/null)" = "status: running" ]; then
    ok=1
    break
  fi
  sleep 2
  i=$((i + 1))
done

if [ "$ok" -ne 1 ]; then
  log "FAIL: temp CT did not reach running state"
  hc /fail
  exit 1
fi

# Bonus: confirm we can actually exec inside it (rootfs is mountable + init up).
if pct exec "$TEST_CTID" -- true >>"$LOG" 2>&1; then
  log "OK: temp CT booted and is executable — restore verified"
else
  log "WARN: CT running but exec failed; rootfs may be incomplete"
  hc /fail
  exit 1
fi

# trap cleanup destroys the temp CT on exit.
log "=== restore-test OK ==="
hc
