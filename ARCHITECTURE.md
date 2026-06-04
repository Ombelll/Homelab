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
| **Proxmox-01** | Physical host | 192.168.1.10 (UI :8006) | Hypervisor, ZFS storage (`tank`), backups (vzdump + offsite), agent. NUT/UPS pending. |
| **postgres** | LXC (CT 100) | 192.168.1.20 | PostgreSQL 16 (shared DB incl. the dashboard's `homelab` DB), secondary AdGuard (DNS fallback), daily `pg_dumpall`, agent. |
| **docker** | LXC (CT 101) | 192.168.1.21 | Docker stack (see services), agent. |
| **PC** | Windows desktop | tailnet 100.73.146.60 | User workstation, agent over Tailscale. |
| *Laptop* | Windows | — | Agent installer ready (`deploy/install-agent.ps1`). |

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
| **Watchtower** (+ socket-proxy) | Image-update monitoring (monitor-only) | — |

## Storage & backups (3-2-1)

- **`tank`** — ZFS pool (~238 GB, single disk `sda`). Holds Immich library, local backups. Monthly scrub. *(No redundancy yet — a mirror/2nd disk is the main open hardening item.)*
- **vzdump** — daily full CT/VM snapshots → `tank-backup`. Integrity-verified.
- **pg_dumpall** — daily logical DB dump on CT 100 (inside vzdump too).
- **Offsite** — `rclone` encrypted mirror of vzdumps → Hetzner Storage Share (crypt over Nextcloud WebDAV). Daily 05:00.

## Network & DNS

- **Tailscale** — all admin access over the tailnet; HTTPS via Tailscale Serve.
- **AdGuard** — LAN DNS + filtering. Primary on CT 101 (.21); secondary on CT 100 (.20) for failover (set router DNS2 = .20).
- **Traefik** — routes `*.lan` to services on the LAN.

## Monitoring

- **Agent** (`agent/`) on every host → reports CPU/mem/disk/swap/net/disk-IO/ZFS/sensors/top-processes/SMART/containers to `/api/agent/report`. Self-update via a dashboard job. Windows via `install-agent.ps1`, Linux via `install-agent.sh`.
- **Alerts** — thresholds (CPU/mem/disk/swap) + state alerts (ZFS health, temperature, failed units, SMART, per-mount disk-full, backup-stale, unhealthy/restart-looping containers) → push via **ntfy**.
- **SNMP** — managed switch (TP-Link SG2008) monitored over SNMP v2c: per-port link speed, admin/oper status, throughput, and a per-interval error/discard *rate* with a `switch-port-errors` alert. Network page. Set `AGENT_SNMP_TARGET` to enable.
- **Health checks** — service probes (HTTP/TCP/ping) plus `tls` cert-expiry checks that alert ahead of expiry.
- **Maintenance jobs** — `/api/internal/{downsample,retention,sweep,run-health-checks,check-image-updates}` driven by a scheduler (cron on CT 101) with `SWEEP_KEY`.
- **Watchdogs** — external dead-man's switches via healthchecks.io: a CT 101 dashboard-liveness ping (so the alerter's own death is noticed) and a monthly backup restore-test on the host (`deploy/watchdogs.md`).

## Security hardening

Cookie-session auth (scrypt, rate-limited login, optional TOTP 2FA), agents on
tailnet HTTPS with per-device revocable keys, `no-new-privileges` on all
containers, scoped Docker socket-proxies, `rpcbind` disabled, automatic security
updates. See the security-hardening memory for host-side specifics.
