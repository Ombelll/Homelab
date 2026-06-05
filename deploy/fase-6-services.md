# Fase 6 — extra services: Jellyfin, Nextcloud, Homepage

Three new Docker services on CT 101, behind Traefik on `*.lan`. This is the
one-time host setup; after it, each service is a normal `compose up -d`.

> ⚠️ Steps 1–2 need CT 101 mount/device changes, which require **one CT 101
> restart**. That briefly takes the dashboard + AdGuard (DNS) down (~30–60 s).
> Do it at a quiet moment. Everything comes back automatically.

## 1. Storage on tank (datasets + CT 101 bind mounts)

```sh
# On the Proxmox HOST. Datasets for media + nextcloud data.
zfs create tank/media
zfs create tank/nextcloud
# Bind them into CT 101 (mp1/mp2 — check `pct config 101` for a free mpN).
pct set 101 -mp1 /tank/media,mp=/mnt/media
pct set 101 -mp2 /tank/nextcloud,mp=/mnt/nextcloud
```

## 2. Intel iGPU into CT 101 (Jellyfin QuickSync — optional)

```sh
# On the HOST. Find the render group GID (note it for the compose group_add):
getent group render        # e.g. render:x:104:
# Pass the DRI devices into the unprivileged CT 101:
cat >> /etc/pve/lxc/101.conf <<'EOF'
lxc.cgroup2.devices.allow: c 226:* rwm
lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir
EOF
```
Put the render GID number into `group_add:` in `jellyfin/docker-compose.yml`
(replace `render` with e.g. `"104"`). Skip this whole step for CPU transcoding.

```sh
# Apply steps 1–2 with one restart:
pct reboot 101
```

## 3. Nextcloud database on the shared Postgres (CT 100)

```sh
# On the HOST — create the DB + role. Pick a strong password and put it in .env.
pct exec 100 -- su -l postgres -c "psql -c \"CREATE USER nextcloud WITH PASSWORD 'CHANGE_ME';\""
pct exec 100 -- su -l postgres -c "psql -c \"CREATE DATABASE nextcloud OWNER nextcloud;\""
```

## 4. Secrets (.env in the repo root on CT 101, /opt/Homelab/.env)

```
NEXTCLOUD_DB_PASSWORD=<same as step 3>
NEXTCLOUD_ADMIN_USER=mike
NEXTCLOUD_ADMIN_PASSWORD=<a strong admin password>
```

## 5. DNS — add the *.lan names in AdGuard

AdGuard → Filters → DNS rewrites, point each at CT 101 (192.168.1.21):
`jellyfin.lan`, `nextcloud.lan`, `home.lan`  → `192.168.1.21`

## 6. Deploy (from /opt/Homelab on CT 101)

```sh
docker compose -f deploy/services/jellyfin/docker-compose.yml up -d
docker compose --env-file .env -f deploy/services/nextcloud/docker-compose.yml up -d
docker compose -f deploy/services/homepage/docker-compose.yml up -d
```

Then browse to `http://jellyfin.lan`, `http://nextcloud.lan`, `http://home.lan`.

## Notes
- **Jellyfin**: add your library at `/media` (host `tank/media`); in the UI →
  Dashboard → Playback, enable Intel QuickSync (VAAPI/QSV) if you did step 2.
- **Nextcloud**: first load runs the installer using the env admin creds. If you
  later expose it over HTTPS, add the tailnet name to `NEXTCLOUD_TRUSTED_DOMAINS`.
- **Resource note**: these all share CT 101 (6 GB). If memory gets tight, bump
  CT 101 RAM (`pct set 101 -memory 8192`) — the host has headroom.
- **Backups**: `tank/media` + `tank/nextcloud` are new data dirs. They ride the
  vzdump of CT 101? No — they're host bind mounts, so add them to the offsite /
  tank backup story if the data matters (Nextcloud especially).
