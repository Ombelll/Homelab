# Disaster-recovery runbook

What to do when something dies. Read top to bottom once now, so the steps are
familiar before you need them. Pick the scenario that matches your failure.

> **The one thing to protect:** the secrets. Proxmox `root` password, the
> Postgres superuser password, the rclone **crypt passwords** (without them the
> offsite backup is unreadable ciphertext), and the dashboard admin login live
> in your password manager — NOT in this repo and NOT only on the box. If you
> lose those, the offsite backup is useless. Verify they're in your password
> manager today.

## Where everything lives

| Thing | Primary | Backup copies |
|-------|---------|---------------|
| Proxmox host config (`/etc`) | host NVMe (`pve` LVM) | `tank:/backups/host-config/*.tar.gz` + **offsite** |
| CT 100 / CT 101 (whole containers) | host NVMe / `tank` | daily **vzdump** → `tank:/backups/dump` → **offsite** |
| Postgres data (all DBs) | CT 100 | logical `pg_dump` in CT 100 `/var/backups/postgres` (rides vzdump) + `tank:/backups/pg` + **offsite** |
| Immich library / media | `tank/immich` | vzdump of CT 101 covers app config; **media is only on `tank`** — the ZFS mirror is its protection |
| Secrets / passwords | **password manager** | (intentionally nowhere else) |
| Offsite | Hetzner Storage Share | rclone `crypt` over WebDAV — needs the crypt passwords |

`tank` is currently a **single disk** — add a mirror (see `ARCHITECTURE.md` /
the ZFS-mirror advice) so a disk failure isn't a data-loss event.

---

## Scenario A — a single CT is broken (most common)

Restore just that container from the newest vzdump; the rest keep running.

```sh
# On the host. List restore points for CT 101:
ls -lt /tank/backups/dump/vzdump-lxc-101-*.zst
# Restore over the broken CT (stop it first). Use --force to overwrite.
pct stop 101
pct restore 101 /tank/backups/dump/vzdump-lxc-101-<TIMESTAMP>.tar.zst --force --storage local-lvm
pct start 101
```

To recover just **one database** (e.g. Vaultwarden) without touching the rest:

```sh
# Inside CT 100, restore into a scratch DB first, verify, then swap.
pct exec 100 -- su -l postgres -c "createdb vaultwarden_new"
pct exec 100 -- su -l postgres -c "pg_restore --no-owner -d vaultwarden_new /var/backups/postgres/vaultwarden-<TS>.dump"
# …check it, then rename old→bak and new→live with the app stopped.
```

---

## Scenario B — host boot disk (NVMe) dies, `tank` (sda) survives

The data on `tank` is intact; you only lost Proxmox itself.

1. **Reinstall Proxmox VE 8.x** on a new NVMe (same version family). Set the
   hostname `Proxmox-01` and management IP `192.168.1.10`.
2. **Import the surviving pool:**
   ```sh
   zpool import tank            # or: zpool import -f tank
   zpool status tank            # confirm ONLINE
   ```
3. **Restore host config** from the newest tarball on tank:
   ```sh
   ls -lt /tank/backups/host-config/
   tar xzf /tank/backups/host-config/host-config-<TS>.tar.gz -C /    # restores /etc/* paths
   ```
   Re-add the storages in the UI if needed (`tank`, `tank-backup`, `local-lvm`)
   and reload services: `systemctl reload pve-firewall; systemctl restart cron`.
4. **Re-create the CTs from vzdump:**
   ```sh
   pct restore 100 /tank/backups/dump/vzdump-lxc-100-<TS>.tar.zst --storage local-lvm
   pct restore 101 /tank/backups/dump/vzdump-lxc-101-<TS>.tar.zst --storage local-lvm
   pct start 100; pct start 101
   ```
5. **Tailscale** — re-auth the host (`tailscale up --advertise-routes=192.168.1.0/24`),
   approve the subnet route + disable key expiry in the Tailscale admin.
6. **Re-arm cron + agents** (host config restored them, but verify):
   `bash /opt/homelab-agent/deploy/install-agent.sh` and check `/etc/cron.d/`.

---

## Scenario C — total loss (fire / theft / dead `tank`)

Everything local is gone. Rebuild from **offsite** (this is why the crypt
passwords matter).

1. New hardware → **install Proxmox VE 8.x** as in Scenario B (steps 1).
2. Recreate `tank` (new disk(s) — ideally a **mirror** this time):
   ```sh
   zpool create tank mirror /dev/disk/by-id/<diskA> /dev/disk/by-id/<diskB>
   zfs create tank/backups; zfs create tank/immich
   ```
3. **Reconnect the offsite remote.** Reinstall rclone, then recreate the
   `offsite` remote (`crypt` wrapping `webdav` → Hetzner) using the WebDAV URL +
   user and the **two crypt passwords** from your password manager:
   ```sh
   rclone config       # recreate webdav remote, then the crypt 'offsite' over it
   rclone lsd offsite: # should list: vzdump  host-config  pg
   ```
4. **Pull everything back:**
   ```sh
   rclone copy offsite:vzdump      /tank/backups/dump
   rclone copy offsite:host-config /tank/backups/host-config
   rclone copy offsite:pg          /tank/backups/pg
   ```
5. Now follow **Scenario B from step 3** (restore host config → restore CTs).
6. Restore **Immich media** only if it was separately backed up — by default the
   library lived only on the old `tank` and is lost in a total-loss event unless
   you'd added offsite media sync. (Photos on phones still have originals.)

---

## Scenario D — accidental deletion / "it was fine yesterday"

- **A file/dataset on tank:** check ZFS snapshots first (instant, no download):
  `zfs list -t snapshot tank` → `zfs rollback` or browse `.zfs/snapshot/`.
- **DB rows / a table:** restore the relevant `pg_dump` into a scratch DB
  (Scenario A) and copy the rows back.
- **A whole CT:** restore yesterday's vzdump (Scenario A).

---

## Keep this runbook honest (quarterly, 10 min)

- [ ] Confirm all secrets (root, Postgres, **rclone crypt passwords**, dashboard) are in the password manager.
- [ ] `rclone lsd offsite:` lists `vzdump`, `host-config`, `pg` and recent timestamps.
- [ ] The monthly `pg-restore-test` + `backup-restore-test` are green (healthchecks.io).
- [ ] You can read this file from somewhere **other than the box** (it's in the Git repo — good).
- [ ] `zpool status tank` shows a mirror (once the 2nd disk is in).
