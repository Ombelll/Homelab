#!/bin/sh
# Liveness watchdog for the dashboard + its maintenance scheduler (CT 101).
#
# "Who watches the watcher": the dashboard is what raises every other alert, so
# if the dashboard process — or the whole CT — is down, it can't tell you. This
# closes that gap with an EXTERNAL dead-man's switch.
#
# Each run it calls the dashboard's internal sweep endpoint, which only returns
# 200 when (a) the dashboard process is up and (b) the SWEEP_KEY matches. On
# success it pings healthchecks.io; on any failure it pings /fail. If the CT is
# down entirely, the cron never runs, no ping arrives, and healthchecks alerts.
#
# Config (kept OFF git): /etc/dashboard-watchdog.env, 0600, e.g.
#   HC_PING_URL="https://hc-ping.com/<uuid>"
#   # SWEEP_KEY is read from /etc/homelab-sweep.key by default; override here
#   # only if you store it elsewhere.
set -eu

URL="${DASHBOARD_INTERNAL_URL:-http://localhost:3000}"
KEY_FILE=/etc/homelab-sweep.key

if [ -f /etc/dashboard-watchdog.env ]; then
  . /etc/dashboard-watchdog.env
fi
HC_PING_URL="${HC_PING_URL:-}"
SWEEP_KEY="${SWEEP_KEY:-}"
# Reuse the same key file the sweep cron already uses, so there's one source.
if [ -z "$SWEEP_KEY" ] && [ -f "$KEY_FILE" ]; then
  SWEEP_KEY=$(cat "$KEY_FILE")
fi

hc() {
  [ -n "$HC_PING_URL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS -m 10 --retry 2 -o /dev/null "${HC_PING_URL}${1:-}" || true
}

# The sweep endpoint is idempotent (it reconciles offline servers); calling it
# here in addition to the every-minute sweep cron is harmless.
code=$(curl -fsS -m 10 -o /dev/null -w '%{http_code}' \
  -X POST "$URL/api/internal/sweep" -H "x-sweep-key: $SWEEP_KEY" 2>/dev/null || echo 000)

if [ "$code" = "200" ]; then
  hc
else
  hc /fail
fi
