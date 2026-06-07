# Fase 7 — extra services: *arr stack, Paperless, Navidrome, Kavita, Dozzle, speedtest

Six more Docker services on CT 101, behind Traefik on `*.lan`. Designed so that
**no new bind mount or CT reboot is needed**: the media-facing ones (Sonarr,
Radarr, qBittorrent, Navidrome, Kavita) all ride the *existing* `/mnt/media`
mount via subdirectories. Everything else uses named volumes.

| Service | Host | Port | Storage | Secrets |
|---|---|---|---|---|
| Prowlarr / Sonarr / Radarr / Bazarr | `prowlarr/sonarr/radarr/bazarr.lan` | 9696/8989/7878/6767 | named + `/mnt/media` | – |
| qBittorrent | `qb.lan` | 8080 | named + `/mnt/media` | – |
| Jellyseerr | `requests.lan` | 5055 | named | – |
| Paperless-ngx (+redis) | `paperless.lan` | 8000 | named | yes |
| Navidrome | `music.lan` | 4533 | `/mnt/media/music` | – |
| Kavita | `books.lan` | 5000 | `/mnt/media/books` | – |
| Dozzle (+socket-proxy) | `logs.lan` | 8080 | – | – |
| speedtest-tracker | `speed.lan` | 80 | named | yes |

## 1. One-time host prep (on CT 101 — no reboot)

```sh
# From the Proxmox host, hop into the container:
pct exec 101 -- bash

# Media subdirs that the new services use, under the existing /mnt/media mount.
# (TRaSH single-root layout for the *arr stack so imports are atomic hardlinks.)
mkdir -p /mnt/media/{downloads,tv,movies,music,books}

# The linuxserver images run as PUID/PGID 1000 (the .env default). In this
# unprivileged CT the bind dir is root-owned, so give 1000:1000 ownership of the
# media tree it must write to (downloads + libraries). Read-only consumers
# (Jellyfin, Navidrome) don't strictly need it, but a uniform owner is simplest.
chown -R 1000:1000 /mnt/media
```

> If you'd rather not chown the whole tree, set `PUID=0`/`PGID=0` in `.env` for a
> quick start — acceptable inside an unprivileged CT, but 1000:1000 is cleaner.

## 2. Give CT 101 more RAM (host has headroom — ~38% used)

Ten extra containers want ~2 GB. Memory can be raised live, no reboot:

```sh
# On the Proxmox HOST:
pct set 101 -memory 12288    # 6 GB -> 12 GB
```

## 3. Secrets — append to /opt/Homelab/.env (CT 101), keep it 0600

```sh
# Generate strong values:
openssl rand -base64 48        # PAPERLESS_SECRET_KEY
echo "base64:$(openssl rand -base64 32)"   # SPEEDTEST_APP_KEY (note the base64: prefix)
```

```
PUID=1000
PGID=1000
TZ=Europe/Amsterdam
PAPERLESS_SECRET_KEY=<rand>
PAPERLESS_ADMIN_USER=mike
PAPERLESS_ADMIN_PASSWORD=<a strong password>
SPEEDTEST_APP_KEY=base64:<rand>
```

## 4. DNS — add the *.lan names in AdGuard

AdGuard → Filters → DNS rewrites, each → CT 101 (`192.168.1.21`):

```
prowlarr.lan  sonarr.lan  radarr.lan  bazarr.lan  qb.lan  requests.lan
paperless.lan  music.lan  books.lan  logs.lan  speed.lan
```

(While you're there, the Fase-6 names if not added yet: `jellyfin.lan`,
`nextcloud.lan`, `home.lan`.)

## 5. Deploy (from /opt/Homelab on CT 101)

```sh
cd /opt/Homelab && git pull
docker compose --env-file .env -f deploy/services/arr/docker-compose.yml up -d
docker compose --env-file .env -f deploy/services/paperless/docker-compose.yml up -d
docker compose --env-file .env -f deploy/services/navidrome/docker-compose.yml up -d
docker compose --env-file .env -f deploy/services/kavita/docker-compose.yml up -d
docker compose -f deploy/services/dozzle/docker-compose.yml up -d
docker compose --env-file .env -f deploy/services/speedtest/docker-compose.yml up -d
```

## 6. First-run notes

- **Prowlarr first**: add your indexers, then add Sonarr + Radarr as "apps" so
  Prowlarr pushes indexers to them. In Sonarr/Radarr set the root folder to
  `/data/tv` and `/data/movies`, and the download client to qBittorrent
  (`qbittorrent:8080`) with download dir `/data/downloads`.
- **qBittorrent** default login is `admin` / a temporary password printed in its
  log on first boot: `docker logs qbittorrent | grep -i password`. Change it.
- **Jellyseerr**: on first load, point it at your Jellyfin (`http://jellyfin:8096`)
  and your *arr apps.
- **Paperless**: log in with `PAPERLESS_ADMIN_USER` / `_PASSWORD`. Upload via the
  UI, or `docker cp` files into the consume volume.
- **Navidrome / Kavita**: create the admin account on first visit; they scan the
  mounted library automatically.
- **speedtest-tracker**: first run seeds the DB; default login `admin@example.com`
  / `password` — change it immediately.

## Notes
- **Backups**: the new state lives in Docker named volumes on CT 101's rootfs, so
  it rides the vzdump of CT 101. Media under `/tank/media` is a host bind mount —
  add it to the offsite story if it matters.
- **qBittorrent is not behind a VPN** in this compose. If your usage needs one,
  wrap it in gluetun (network_mode: service:gluetun) with your provider creds.
