#!/bin/sh
# Opt-in auto-deploy — run on the Proxmox host from cron. If main has new
# commits, run deploy.sh so a push goes live by itself.
#
#   */10 * * * * root bash /opt/homelab-agent/deploy/auto-deploy.sh >> /var/log/auto-deploy.log 2>&1
#
# NOTE the explicit `bash`: cron runs the file directly, and a git checkout can
# drop the executable bit, so invoking via bash avoids a "Permission denied".
#
# Trust model: this runs the latest main as root, same as the agent self-update
# — gate it with GitHub branch protection on `main` + 2FA on the GitHub account.
set -eu

DASH_CT="${DASH_CT:-101}"
DASH_DIR="${DASH_DIR:-/opt/Homelab}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

pct exec "$DASH_CT" -- git -C "$DASH_DIR" fetch -q origin
local_head=$(pct exec "$DASH_CT" -- git -C "$DASH_DIR" rev-parse HEAD)
remote_head=$(pct exec "$DASH_CT" -- git -C "$DASH_DIR" rev-parse origin/main)

if [ "$local_head" = "$remote_head" ]; then
  echo "$(date -Is) up to date ($local_head)"
  exit 0
fi

echo "$(date -Is) new commit $remote_head (was $local_head) — deploying"
sh "$SELF_DIR/deploy.sh"
