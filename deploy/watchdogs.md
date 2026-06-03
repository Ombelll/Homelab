# Watchdogs: dashboard liveness + backup restore-test

Two host-side safety nets that cover failure modes the in-app alerter can't:

| Script | Runs on | Catches |
|--------|---------|---------|
| `dashboard-watchdog.sh` | CT 101 | The dashboard / its scheduler / the whole CT being down — the alerter can't alert on its own death. |
| `backup-restore-test.sh` | Proxmox host | A backup that exists but doesn't actually restore. |

Both are no-ops until you give them a healthchecks.io URL, so they're safe to
install ahead of time. Each ping URL is a capability and this repo is public,
so the URLs live ONLY in `0600` env files on the hosts — never in git.

## 1. Dashboard liveness watchdog (CT 101)

Calls the dashboard's internal sweep endpoint (200 only when the process is up
and `SWEEP_KEY` matches) and pings healthchecks on success.

```sh
# inside CT 101
install -m 0755 dashboard-watchdog.sh /usr/local/bin/dashboard-watchdog.sh
printf 'HC_PING_URL="https://hc-ping.com/<uuid>"\n' > /etc/dashboard-watchdog.env
chmod 600 /etc/dashboard-watchdog.env
# every 5 minutes
printf '*/5 * * * * root /usr/local/bin/dashboard-watchdog.sh\n' > /etc/cron.d/dashboard-watchdog
```

On healthchecks.io set **period 10 min**, **grace 5 min**. `SWEEP_KEY` is read
from `/etc/homelab-sweep.key` (the file the sweep cron already uses).

## 2. Backup restore-test (Proxmox host)

Monthly: restores the newest vzdump of a CT to a throwaway CTID, boots it,
confirms it runs and is exec-able, then stops and destroys the temp CT. It
never touches the real CT — `pct restore` makes a brand-new container.

```sh
# on the Proxmox host
install -m 0755 backup-restore-test.sh /usr/local/bin/backup-restore-test.sh
cat > /etc/backup-restore-test.env <<'EOF'
HC_PING_URL="https://hc-ping.com/<uuid>"
SRC_CTID=100        # test the small Postgres LXC by default
TEST_CTID=990       # must be a FREE id
STORAGE=local-lvm   # where to restore the temp rootfs
EOF
chmod 600 /etc/backup-restore-test.env
# 1st of the month, 06:00 (after the nightly backups)
printf '0 6 1 * * root /usr/local/bin/backup-restore-test.sh\n' > /etc/cron.d/backup-restore-test
```

On healthchecks.io set **period 1 month**, **grace ~1 day**. Pick `TEST_CTID`
that is not in use (`pct status 990` should say "does not exist"), and make
sure the chosen `STORAGE` has room for the restored rootfs. A `cleanup` trap
destroys the temp CT even if the test fails partway through.

Kick off a manual run to verify:
```sh
/usr/local/bin/backup-restore-test.sh; tail -n 20 /var/log/backup-restore-test.log
```
