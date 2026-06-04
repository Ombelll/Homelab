# Homelab Control Center

[![CI](https://github.com/Ombelll/Homelab/actions/workflows/ci.yml/badge.svg)](https://github.com/Ombelll/Homelab/actions/workflows/ci.yml)

A clean, self-hostable web dashboard for monitoring and managing the servers
and Docker containers in your homelab. Built with Next.js (App Router),
TypeScript, Tailwind, Prisma + PostgreSQL, and a lightweight Node.js agent.

> Status: **v1.6**. Auth + RBAC with optional TOTP 2FA, real container control
> via a per-host agent, live log streaming, sustained-threshold and state
> alerts (CPU/mem/disk/swap + ZFS health, temperature, failed units, SMART,
> per-mount disk, backup freshness) with Discord / ntfy / webhook / SMTP
> notifications, metric downsampling + retention, SNMP switch monitoring,
> invite flow, health checks, Wake-on-LAN, image update detection,
> backup/restore, audit log. Runs on PostgreSQL.

## Features

- Real-time dashboard: server counts, online / warning / critical states,
  average CPU / memory / disk, recent alerts, container summary.
- Servers page: hostname, IP, OS, status, last-seen, latest metrics.
- Containers page: image, status, ports, host, with start / stop / restart
  and "view logs" actions.
- Alerts page with severity, source server, and resolution state.
- Lightweight Node.js agent that collects host metrics — CPU/mem/disk/swap,
  per-disk usage, network + disk-I/O rates, ZFS pool health, hwmon
  temperatures, top processes, SMART status, backup freshness — and (if Docker
  is installed) container state, then POSTs to the dashboard with an
  `X-Agent-Key` header.
- Optional SNMP polling of a managed switch (interfaces, traffic), shown on a
  Network page.
- Runs on PostgreSQL.
- Dark-mode UI, responsive layout, sidebar navigation.

## Architecture

```
┌────────────────────────┐      POST /api/agent/report         ┌──────────────────┐
│  homelab-agent (Node)  │  ────────────────────────────────►  │  Next.js routes  │
│  metrics + docker ps   │      X-Agent-Key: <shared>          │  validate & save │
│  + ZFS/SMART/SNMP/…     │  ◄────────────────────────────────  │  via Prisma      │
└────────────────────────┘      GET /api/agent/jobs (poll)      └────────┬─────────┘
                                                                        │
                                                                        ▼
                                                                ┌──────────────┐
                                                                │ PostgreSQL   │
                                                                └──────┬───────┘
                                                                        ▼
                                                                ┌──────────────┐
                                                                │  Dashboard   │
                                                                │  (App Router │
                                                                │   server     │
                                                                │   components)│
                                                                └──────────────┘
```

Container control flows the other way without ever giving the dashboard
Docker socket access: the dashboard enqueues a job, the agent on the target
host polls `GET /api/agent/jobs`, performs the action via the local Docker CLI,
and reports the result back. See [`AGENTS.md`](./AGENTS.md) for the full flow.
For the physical topology (Proxmox host, LXCs, storage, network) see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Deployment

Need a step-by-step runbook to deploy this on a Proxmox host with a Docker
LXC and a shared PostgreSQL LXC? See **[docs/deploy-plan.md](docs/deploy-plan.md)** —
opinionated, eleven phases, written for a 16 GB mini-PC homelab.

## Quick start

```bash
# 1. install dependencies (lockfile is committed, npm ci works)
npm ci

# 2. configure env
cp .env.example .env
# edit .env: set DATABASE_URL to a PostgreSQL URL and a strong AGENT_API_KEY
# (e.g. `openssl rand -hex 32`). A local Postgres for dev:
#   docker run -d --name pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine
#   DATABASE_URL="postgresql://postgres:dev@localhost:5432/postgres?schema=public"

# 3. create the schema
npx prisma db push
npm run db:seed    # optional — populates demo servers / containers / alerts

# 4. run the dashboard
npm run dev
# open http://localhost:3000
```

On first visit you'll be redirected to `/register` to create the admin
account. Subsequent users are invited from Settings → Invite users.

### Local development shortcut

To skip the register dance every time you nuke the DB, opt-in to a dev
admin user in the seed:

```bash
SEED_DEV_USER=1 SEED_DEV_PASSWORD=changeme npm run db:seed
# now log in with admin@local / changeme
```

This is off by default so production seeds never ship with a known
credential.

### Run the agent (on the host you want to monitor)

```bash
cd agent
npm install

# point it at the dashboard
export DASHBOARD_URL="http://localhost:3000"
export AGENT_API_KEY="<same value as the dashboard>"
npm run dev
```

The agent will check in, then send metrics (and Docker container state, if
Docker is installed) every 30 seconds.

### Run with Docker Compose

The dashboard runs on Postgres. Point `DATABASE_URL` at your database and
bring up the stack:

```bash
cp .env.example .env
# set AGENT_API_KEY and DATABASE_URL (postgresql://user:pass@host:5432/dbname)
docker compose up -d --build
```

On boot the container runs `prisma db push`, so the schema is created/updated
automatically. In this homelab the Postgres instance lives in CT 100 and the
dashboard runs in CT 101.

## Tests

Two suites — fast pure-function tests and slower integration tests that hit a
real Postgres via Prisma. The integration harness carves out a throwaway
schema (dropped on teardown), so it never touches real data.

```bash
npm test                  # unit + pure-function tests (~5s)

# Integration tests need a Postgres URL. Without one they skip cleanly.
TEST_DATABASE_URL=postgresql://user:pass@host:5432/dbname npm run test:integration
```

Both run on every push via GitHub Actions; the badge above tracks main.

## Environment variables

| Var | Where | Description |
|-----|-------|-------------|
| `DATABASE_URL` | dashboard | PostgreSQL connection string (required), e.g. `postgresql://user:pass@host:5432/db`. |
| `AGENT_API_KEY` | dashboard + agent | Shared secret sent in the `X-Agent-Key` header. |
| `NEXT_PUBLIC_APP_URL` | dashboard | Public base URL of the dashboard. |
| `SWEEP_KEY` | dashboard | Guards the `/api/internal/*` maintenance endpoints (open if unset). |
| `TEST_DATABASE_URL` | tests | Postgres URL for the integration suite; without it the suite skips. |
| `DASHBOARD_URL` | agent | Base URL the agent posts to (use the HTTPS/tailnet URL). |
| `AGENT_SERVER_NAME` | agent | Friendly name for this host (defaults to hostname). |
| `AGENT_INTERVAL_SECONDS` | agent | Reporting interval; default `30` (min 5). |
| `AGENT_REQUEST_TIMEOUT_SECONDS` | agent | Hard timeout per outbound request; default `15` (2–120). |
| `AGENT_BACKUP_DIR` | agent | Dir scanned for `vzdump*` to report backup age; default `/tank/backups/dump`. |
| `AGENT_SNMP_TARGET` | agent | IP of a managed switch to poll over SNMP. Dormant unless set. |
| `AGENT_SNMP_COMMUNITY` | agent | SNMP v2c community; default `public`. |

## Security notes

- **Run behind a VPN.** Tailscale, WireGuard, or a trusted LAN. Do not expose
  the dashboard directly to the public internet without putting an
  authenticating reverse proxy in front of it.
- **Use a long, random `AGENT_API_KEY`** — at least 32 hex characters. Rotate
  it if you suspect leakage.
- **Do not mount `/var/run/docker.sock` into the dashboard container.** It is
  effectively root on the host. The dashboard's container control endpoints
  are designed to delegate to per-host agents instead — see
  [`AGENTS.md`](./AGENTS.md).
- All agent input is validated with Zod before hitting the database.
- All API responses are JSON and avoid leaking stack traces.
- **Optional TOTP 2FA.** Enable per-account under Settings → Account; logins
  then require a code from an authenticator app (recovery codes provided once).
- Login is rate-limited and passwords are scrypt-hashed.

## Scheduled maintenance

Two internal endpoints, both gated by `SWEEP_KEY` (open if unset):

```bash
# Offline detection: flip stale servers to "offline", manage agent-missing alerts.
* * * * * curl -fsS -X POST http://dashboard/api/internal/sweep \
  -H "x-sweep-key: $SWEEP_KEY" > /dev/null

# Downsample: roll raw metrics into hourly aggregates so long ranges stay fast.
*/15 * * * * curl -fsS -X POST http://dashboard/api/internal/downsample \
  -H "x-sweep-key: $SWEEP_KEY" > /dev/null

# Retention: prune metrics, resolved alerts, and completed jobs older than N days.
30 3 * * * curl -fsS -X POST "http://dashboard/api/internal/retention?days=30" \
  -H "x-sweep-key: $SWEEP_KEY" > /dev/null

# Health checks: probe every enabled service whose interval has elapsed.
* * * * *  curl -fsS -X POST http://dashboard/api/internal/run-health-checks \
  -H "x-sweep-key: $SWEEP_KEY" > /dev/null

# Image updates: check Docker Hub for newer image digests (every 6h per image).
0 4 * * *  curl -fsS -X POST http://dashboard/api/internal/check-image-updates \
  -H "x-sweep-key: $SWEEP_KEY" > /dev/null

# Digest (optional): a health summary to all notification channels. Daily 08:00.
0 8 * * *  curl -fsS -X POST http://dashboard/api/internal/digest \
  -H "x-sweep-key: $SWEEP_KEY" > /dev/null
```

The downsample job must run before the retention job for any given hour
(retention drops raw metrics that the rollup is supposed to read). The
15-minute downsample + 3am retention schedule above gives a comfortable
margin.

The metric table grows ~1 row per server per agent tick. Without retention a
30-second interval over 5 hosts produces ~430k rows/month — Postgres handles
it fine, but downsampling + a daily prune keep long-range queries snappy.

## Roadmap

- ✅ Real Docker control via agent job queue.
- ✅ Container log retrieval (`docker logs --tail`).
- ✅ Threshold-based alert engine with auto-resolve.
- ✅ Historical sparklines on the server detail page.
- ✅ Per-agent API keys with revocation (Settings → Agent API keys).
- ✅ Offline detection sweep.
- ✅ Multi-user auth (scrypt + signed session cookie; bootstrap-only register).
- ✅ Retention sweep for metrics, resolved alerts, completed jobs.
- ✅ Live log streaming (SSE + chunked uploads from agent, with cancel).
- ✅ Invite flow for additional users (Settings → Invite users).
- ✅ Migrated to PostgreSQL (single provider; `prisma db push` on boot).
- ✅ Optional TOTP 2FA on login (opt-in, with recovery codes).
- ✅ State alerts: ZFS health, temperature, failed systemd units, SMART, per-mount disk, backup freshness, unhealthy/restart-looping containers.
- ✅ SNMP monitoring of a managed switch (Network page).
- ✅ TLS-certificate expiry checks (health-check type `tls`) with ahead-of-time alerts.
- ✅ Offsite backups: rclone-encrypted vzdump mirror to Hetzner (3-2-1), with a healthchecks.io dead-man's switch.
- ✅ Watchdogs: external dashboard-liveness check + monthly automated backup restore-test (`deploy/watchdogs.md`).
- ✅ Notification integrations: Discord, ntfy, generic JSON webhook, SMTP/email.
- ✅ Downsampling for the metric table (hourly avg/max per server).
- ✅ Per-user roles (admin vs. viewer, enforced server-side and in the UI).
- ✅ Mobile navigation (hamburger + slide-over drawer).
- ✅ Self-serve password change (with optional sign-out of other devices).
- ✅ Session + Invite retention as part of the retention sweep.
- ✅ Service-level health checks (HTTP / TCP / ping) with alerts on N-down.
- ✅ docker-compose stack grouping in the containers list.
- ✅ Per-container CPU & memory from `docker stats`.
- ✅ Per-disk usage + Linux hwmon sensor readings on the server detail.
- ✅ Alert ack / snooze / manual resolve, with sustained-N-samples
     openings and maintenance windows.
- ✅ Backup / restore tooling (JSON dump + wipe-and-restore).
- ✅ Audit log of admin actions (Settings → Audit log, with filters).
- ✅ Per-host agent keys (optional hostname binding on AgentKey).
- ✅ Wake-on-LAN with per-server MAC address.
- ✅ Container image update notifications (Docker Hub digest check).

## Project layout

```
.
├── prisma/                 # schema + seed
├── src/
│   ├── app/                # Next.js App Router pages + API routes
│   ├── components/         # shared React components
│   └── lib/                # prisma client, auth, validation, utils
├── agent/                  # standalone Node.js agent
├── deploy/                 # deployment runbooks + installers (agent, offsite, NUT)
├── docs/deploy-plan.md     # opinionated end-to-end Proxmox runbook
├── Dockerfile
├── docker-compose.yml
├── ARCHITECTURE.md         # physical topology: host, LXCs, storage, network
├── AGENTS.md               # agent design + Docker control flow
└── README.md
```

## License

MIT — do whatever, no warranty.
