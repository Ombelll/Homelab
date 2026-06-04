#!/bin/sh
# Verify the newest Postgres logical backup actually restores. A backup you've
# never restored is a hope, not a backup. Monthly companion to pg-backup.sh.
#
# Restores the newest pg_dump into a THROWAWAY database inside CT 100, runs a
# sanity query, then drops it. Never touches the live database. Run on the
# Proxmox host as root, e.g. monthly:
#   30 4 1 * *  /opt/homelab-agent/deploy/pg-restore-test.sh >> /var/log/pg-restore-test.log 2>&1
#
# Reuses /etc/pg-backup.env (PG_CT, PG_DB, PG_USER, IN_CT_DIR). Optional own
# dead-man's switch via HC_RESTORE_PING_URL in that file.
set -eu

LOG=/var/log/pg-restore-test.log

[ -f /etc/pg-backup.env ] && . /etc/pg-backup.env
PG_CT="${PG_CT:-100}"
PG_DB="${PG_DB:-homelab}"
PG_USER="${PG_USER:-postgres}"
IN_CT_DIR="${IN_CT_DIR:-/var/backups/postgres}"
TESTDB="${PG_DB}_restoretest"
HC="${HC_RESTORE_PING_URL:-}"

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

# Always drop the scratch DB on exit, even on failure, so we never leave it.
cleanup() {
  pct exec "$PG_CT" -- su -l "$PG_USER" -c "dropdb --if-exists '$TESTDB'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { log "FAILED: $*"; hc /fail; exit 1; }

hc /start
command -v pct >/dev/null 2>&1 || fail "pct not found (run on the Proxmox host)"
pct status "$PG_CT" 2>/dev/null | grep -q running || fail "CT $PG_CT not running"

# Newest dump inside the CT.
dump=$(pct exec "$PG_CT" -- sh -c "ls -1t '$IN_CT_DIR'/${PG_DB}-*.dump 2>/dev/null | head -1")
[ -n "$dump" ] || fail "no dump found in CT $PG_CT:$IN_CT_DIR (run pg-backup.sh first)"
log "restoring $dump into scratch DB $TESTDB"

# Fresh scratch DB, then restore. pg_restore exits non-zero on warnings too, so
# we don't 'set -e' it away — we judge success by the sanity query below.
pct exec "$PG_CT" -- su -l "$PG_USER" -c "dropdb --if-exists '$TESTDB' && createdb '$TESTDB'" \
  || fail "could not create scratch DB"
pct exec "$PG_CT" -- su -l "$PG_USER" -c "pg_restore --no-owner --no-privileges -d '$TESTDB' '$dump'" \
  >>"$LOG" 2>&1 || log "pg_restore reported warnings (continuing to sanity check)"

# Sanity: the Server table must exist and be queryable. A restore that silently
# produced an empty/corrupt DB fails here.
count=$(pct exec "$PG_CT" -- su -l "$PG_USER" -c \
  "psql -tAqc 'SELECT count(*) FROM \"Server\"' '$TESTDB'" 2>>"$LOG" || echo "ERR")
case "$count" in
  ''|*[!0-9]*) fail "sanity query failed (Server count='$count') — restore is NOT trustworthy" ;;
esac
log "restore OK — Server rows: $count"
hc
log "pg-restore-test complete"
