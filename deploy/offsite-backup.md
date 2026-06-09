# Offsite backup — encrypted vzdump mirror to Hetzner Storage Share

Closes the 3-2-1 gap: the host's vzdump archives (full CT/VM backups, incl.
Postgres + Vaultwarden) are mirrored, **end-to-end encrypted**, to the rented
Hetzner Storage Share (managed Nextcloud) over WebDAV.

`rclone` + the `deploy/offsite-backup.sh` script + a daily cron are installed on
the host. The script is DORMANT until you create the `offsite` rclone remote
below — that's the only step that touches your credentials, so **you** run it
(not the agent).

## One-time setup (run on the Proxmox host shell)

### 1. Create a Nextcloud app password
In the Storage Share web UI: **Settings → Security → Devices & sessions →
Create new app password**. Name it `rclone`. Copy the generated password — this
is NOT your login password and can be revoked independently.

Also note your **username** (the Nextcloud login).

### 2. Create the rclone remotes

WebDAV remote to the Storage Share (replace `<USER>` and `<APP_PASSWORD>`):
```sh
rclone config create hetzner webdav \
  url=https://nx100009.your-storageshare.de/remote.php/dav/files/<USER>/ \
  vendor=nextcloud \
  user=<USER> \
  pass=<APP_PASSWORD>
```

Encrypted layer on top (pick a STRONG crypt password — see warning):
```sh
rclone config create offsite crypt \
  remote=hetzner:homelab-backup \
  password=<CRYPT_PASSWORD>
```

> ⚠️ **Save the CRYPT password somewhere safe — store it in Vaultwarden.**
> It is required to restore. If you lose it, the offsite backups are
> permanently unreadable (that's the point of the encryption). It is NOT the
> app password and NOT recoverable from the provider.

### 3. Verify
```sh
rclone mkdir offsite:                 # creates the encrypted root
echo hi | rclone rcat offsite:test.txt && rclone cat offsite:test.txt && rclone delete offsite:test.txt
```
If that round-trips "hi", encryption + upload + download all work.

## What runs automatically
- `/usr/local/bin/offsite-backup.sh` — `rclone sync /tank/backups/dump offsite:vzdump`
- `/etc/cron.d/offsite-backup` — daily at 05:00 (after the 03:00 vzdump finishes)
- Log: `/var/log/offsite-backup.log`

## Dead-man's switch (healthchecks.io)

The script pings a [healthchecks.io](https://healthchecks.io) check: `/start`
when it begins, success on a clean sync, and `/fail` (with the log tail) on any
error or skip. If a run never happens — host down, cron broken, rclone wedged —
no success ping arrives and healthchecks emails you. This catches the failures
the in-dashboard `backupAgeHours` alert can't (e.g. the whole host being off).

The ping URL is a capability, so it lives **only on the host**, not in git
(this repo is public). Store it in `/etc/offsite-backup.env`:

```sh
printf 'HC_PING_URL="https://hc-ping.com/<your-uuid>"\n' > /etc/offsite-backup.env
chmod 600 /etc/offsite-backup.env
```

On healthchecks.io, set the check's **period** to 1 day and a **grace** of a
few hours (the run is 05:00; the 03:00 vzdump must finish first). With no
`HC_PING_URL` set the pings are simply no-ops.

Kick off the first run manually once configured:
```sh
/usr/local/bin/offsite-backup.sh && tail -n 20 /var/log/offsite-backup.log
```

## Restore (disaster recovery)
```sh
# list snapshots offsite
rclone lsf offsite:vzdump
# pull one back, then restore the CT
rclone copy offsite:vzdump/vzdump-lxc-101-XXXX.tar.zst /tank/backups/dump/
pct restore <newid> /tank/backups/dump/vzdump-lxc-101-XXXX.tar.zst
```

## Troubleshooting

**`413 Request Entity Too Large` in the log.** The Storage Share (managed
Nextcloud behind openresty) rejects a single large PUT. Fix = Nextcloud chunked
upload. The script passes `--webdav-nextcloud-chunk-size 32M`; bake it into the
remote too so manual `rclone` calls chunk as well:
```sh
rclone config update hetzner nextcloud_chunk_size 32M
```
**Verified 2026-06-09:** 100M still 413'd, **32M works** (server limit is
between the two). If you ever see 413 again, go smaller (`16M`) in both places.

## Notes
- Encryption is client-side (rclone `crypt`); the provider stores only ciphertext with encrypted filenames.
- 1 TB/month easily holds the ~14-day local retention (~100 GB of vzdumps).
- To throttle upload on a slow uplink, add `--bwlimit 10M` to the script's rclone line.
- Run-freshness is covered by the healthchecks.io dead-man's switch above.
