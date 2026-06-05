# Homelab architecture

Everything runs on **one physical machine** — an Intel i5-9400t mini-PC running
**Proxmox VE 8.4**. The "servers" below are mostly LXC containers on that box,
plus a Windows PC. Off-box there's a rented Hetzner Storage Share for offsite
backups.

```
                          Internet
                             │
                    ┌────────┴────────┐
                    │   Tailscale     │  (tailnet: *.tailf562d8.ts.net)
                    └────────┬────────┘
                             │  HTTPS (Tailscale Serve)
┌────────────────────────────────────────────────────────────────┐
│  Proxmox-01  (192.168.1.10, mini-PC i5-9400t, ZFS "tank")        │
│                                                                  │
│  ┌──────────────────────┐   ┌──────────────────────────────┐    │
│  │ CT 100  "postgres"   │   │ CT 101  "docker"             │    │
│  │ 192.168.1.20         │   │ 192.168.1.21                 │    │
│  │ • PostgreSQL 16      │◄──┤ • Traefik (reverse proxy)    │    │
│  │   (vaultwarden, n8n, │   │ • dashboard (this app)       │    │
│  │    forgejo, immich,  │   │ • AdGuard (primary DNS)      │    │
│  │    + dashboard DB)   │   │ • Vaultwarden                │    │
│  │ • AdGuard #2 (DNS    │   │ • Immich (server/ml/pg/redis)│    │
│  │   fallback)          │   │ • n8n, Forgejo, Uptime Kuma  │    │
│  │ • agent              │   │ • Watchtower                 │    │
│  └──────────────────────┘   │ • agent                      │    │
│  • agent (host)             └──────────────────────────────┘    │
│  • vzdump backups → tank-backup → rclone → Hetzner (offsite)     │
└──────────────────────────────────────────────────────────────────┘
        ▲ agent (Tailscale)
   ┌────┴─────┐
   │   PC     │  Windows desktop, monitored over Tailscale
   └──────────┘
```

## Hosts (monitored in the dashboard)

| Host | Type | Address | Role |
|------|------|---------|------|
| **Proxmox-01** | Physical host | 192.168.1.10 (UI :8006) | Hypervisor, ZFS storage (`tank`), backups (vzdump + offsite), agent. On a Green Cell 600VA UPS monitored via NUT (`blazer_usb`); host firewall (nftables) + fail2ban. |
| **postgres** | LXC (CT 100) | 192.168.1.20 | PostgreSQL 16 (shared DB incl. the dashboard's `homelab` DB), secondary AdGuard (DNS fallback), nightly logical `pg_dump -Fc` (`pg-backup.sh`) + monthly restore-test, agent. Firewalled: 5432 reachable only from CT 101. |
| **docker** | LXC (CT 101) | 192.168.1.21 | Docker stack (see services), agent. |
| *Laptop* | Windows | — | Agent installer ready (`deploy/install-agent.ps1`). |

*(The Windows PC was decommissioned from monitoring — agent disabled and the server removed via the dashboard's Danger-zone delete.)*

## Services (containers on CT 101)

| Service | Purpose | Reached at |
|---------|---------|------------|
| **homelab-dashboard** | This monitoring dashboard (Postgres-backed) | `proxmox-01.tailf562d8.ts.net` |
| **Traefik** (+ socket-proxy) | Reverse proxy; HTTPS via Tailscale Serve, `*.lan` routing | :80 / tailnet |
| **AdGuard** | Network DNS + ad/tracker blocking (primary) | 192.168.1.21:53 |
| **Vaultwarden** | Password manager (Bitwarden-compatible) | `docker.tailf562d8.ts.net` |
| **Immich** (server/ml/postgres/redis) | Photo & video backup; library on `tank` | `immich.lan` |
| **n8n** | Workflow automation | `n8n.lan` |
| **Forgejo** | Self-hosted Git | `git.lan`, SSH :2222 |
| **Uptime Kuma** | Uptime/health monitoring | `uptime.lan` |
| **Jellyfin** | Media server (movies/series); iGPU QuickSync transcoding; library on `tank` | `jellyfin.lan` |
| **Nextcloud** | Files/calendar/contacts (on shared Postgres + Redis); data on `tank` | `nextcloud.lan` |
| **Homepage** | Start page linking all services (config in git) | `home.lan` |
| **Watchtower** (+ socket-proxy) | Image-update monitoring (monitor-only) | — |

## Storage & backups (3-2-1)

- **`tank`** — ZFS pool (~238 GB, single disk `sda`). Holds Immich library, local backups. Monthly scrub. *(No redundancy yet — a mirror/2nd disk is the main open hardening item.)*
- **vzdump** — daily full CT/VM snapshots → `tank-backup`. Integrity-verified; a monthly host job restores the newest vzdump into a throwaway CTID and boots it (`deploy/backup-restore-test.sh`).
- **pg_dump** — nightly logical DB dump (`pg_dump -Fc`, `deploy/pg-backup.sh`) inside CT 100 (rides along in the vzdump → offsite) plus a copy on `tank`. A monthly `deploy/pg-restore-test.sh` restores the newest dump into a scratch DB and sanity-checks it — a backup that's never restored is just a hope.
- **Offsite** — `rclone` encrypted mirror of `tank/backups/{dump,host-config,pg}` → Hetzner Storage Share (crypt over Nextcloud WebDAV). Daily 05:00. healthchecks.io dead-man's switches on the offsite + restore jobs.
- **Disaster recovery** — step-by-step rebuild-from-zero playbook in [`deploy/disaster-recovery.md`](deploy/disaster-recovery.md) (single-CT, dead-NVMe, total-loss, accidental-deletion scenarios).

## Network & DNS

- **Tailscale** — all admin access over the tailnet; HTTPS via Tailscale Serve.
- **AdGuard** — LAN DNS + filtering. Primary on CT 101 (.21); secondary on CT 100 (.20) for failover (set router DNS2 = .20).
- **Traefik** — routes `*.lan` to services on the LAN.

## Monitoring

- **Agent** (`agent/`) on every host → reports CPU/mem/disk/swap/net/disk-IO/ZFS/sensors/top-processes/SMART/containers to `/api/agent/report`. Self-update via a dashboard job. Windows via `install-agent.ps1`, Linux via `install-agent.sh`.
- **Alerts** — thresholds (CPU/mem/disk/swap) + state alerts (ZFS health, temperature, failed units, SMART degradation incl. NVMe media-errors/critical-warning/low-spare, per-mount disk-full, **capacity fill-up forecast** (projected days-to-full per disk/pool), backup-stale, UPS-on-battery, OOM-killed / unhealthy / restart-looping containers) → push via **ntfy**, with quiet-hours suppression for non-critical alerts.
- **SNMP** — managed switch (TP-Link SG2008) monitored over SNMP v2c: per-port link speed, admin/oper status, throughput, and a per-interval error/discard *rate* with a `switch-port-errors` alert. Network page. Set `AGENT_SNMP_TARGET` to enable.
- **Health checks** — service probes (HTTP/TCP/ping/`tls` cert-expiry) with per-check 24h uptime %. Infra entry-points (Traefik :80, AdGuard DNS :53, Forgejo SSH :2222, dashboard TLS cert) are probed here; app-level uptime lives in the dedicated **Uptime Kuma**. A ping/TCP check to 1.1.1.1 = WAN-uptime monitoring.
- **Power** — whole-host watts via Intel RAPL (sums all package + DRAM domains) → kWh/cost estimate + history. **Logs** — agent ships warn/error lines (host journal + container logs), filtering known-benign kernel/LXC noise, to a searchable store. **Status page** — optional token-gated public read-only page at `/status/<token>`.
- **Capacity forecast** — hourly `CapacitySample` snapshots per mount/pool feed a least-squares trend that projects days-to-full (shown as an ETA on the server page + a forecast alert).
- **Maintenance jobs** — `/api/internal/{downsample,retention,sweep,run-health-checks,check-image-updates}` driven by a scheduler (cron on CT 101) with `SWEEP_KEY`; `downsample` also writes the capacity snapshots.
- **Watchdogs** — external dead-man's switches via healthchecks.io: a CT 101 dashboard-liveness ping (so the alerter's own death is noticed) and a monthly backup restore-test on the host (`deploy/watchdogs.md`).

## Security hardening

Cookie-session auth (scrypt, rate-limited login, optional TOTP 2FA), agents on
tailnet HTTPS with per-device revocable keys, `no-new-privileges` + dropped
capabilities on containers, scoped Docker socket-proxies, `rpcbind` disabled,
automatic security updates.

Host & network:
- **nftables host firewall** (`/etc/nftables-homelab.nft`) — default-drop inbound, allow only SSH/8006/SPICE/console/Tailscale + established; reboot-persistent.
- **fail2ban** — bans SSH brute-force sources (`deploy/setup-fail2ban.sh`), ignoring LAN + tailnet.
- **CT isolation** — Proxmox firewall on CT 100 so Postgres :5432 is reachable only from CT 101 (`deploy/setup-ct-firewall.sh`; cluster policy stays ACCEPT so the host firewall above remains authoritative).

See the security-hardening memory for host-side specifics.

## Deploy

- **One-command deploy** — `deploy/deploy.sh` on the host rebuilds CT 101 (git pull + `compose up --build`, `prisma db push` on boot) and refreshes every agent.
- **Auto-deploy** — `deploy/auto-deploy.sh` from cron deploys whenever `main` moves. Trust model: it runs the latest `main` as root, so gate `main` with GitHub branch protection + account 2FA.
- Servers can be retired from the UI (admin Danger-zone delete; also drops their alerts).
