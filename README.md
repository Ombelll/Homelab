# Homelab Control Center

A clean, self-hostable web dashboard for monitoring and managing the servers
and Docker containers in your homelab. Built with Next.js (App Router),
TypeScript, Tailwind, Prisma + SQLite, and a lightweight Node.js agent.

> Status: **MVP (v0.1)**. Stable enough to monitor a small fleet. Container
> control endpoints are wired up but the agent-side execution path is mocked
> — see the roadmap below.

## Features

- Real-time dashboard: server counts, online / warning / critical states,
  average CPU / memory / disk, recent alerts, container summary.
- Servers page: hostname, IP, OS, status, last-seen, latest metrics.
- Containers page: image, status, ports, host, with start / stop / restart
  and "view logs" actions.
- Alerts page with severity, source server, and resolution state.
- Lightweight Node.js agent that collects host metrics and (if Docker is
  installed) container state, then POSTs to the dashboard with an
  `X-Agent-Key` header.
- SQLite by default — no database server to run.
- Dark-mode UI, responsive layout, sidebar navigation.

## Architecture

```
┌────────────────────────┐         POST /api/agent/*           ┌──────────────────┐
│  homelab-agent (Node)  │  ────────────────────────────────►  │  Next.js routes  │
│  collects CPU/mem/disk │      X-Agent-Key: <shared>          │  validate & save │
│  + docker ps           │                                     │  via Prisma      │
└────────────────────────┘                                     └────────┬─────────┘
                                                                        │
                                                                        ▼
                                                                ┌──────────────┐
                                                                │  SQLite DB   │
                                                                └──────┬───────┘
                                                                        ▼
                                                                ┌──────────────┐
                                                                │  Dashboard   │
                                                                │  (App Router │
                                                                │   server     │
                                                                │   components)│
                                                                └──────────────┘
```

Container control will eventually flow the other way: the dashboard enqueues
a job; the agent on the target host polls (or holds a connection open),
performs the action via the local Docker socket, and reports back. The
dashboard never gets direct Docker socket access.

## Quick start

```bash
# 1. install dependencies
npm install

# 2. configure env
cp .env.example .env
# edit .env and set a strong AGENT_API_KEY (e.g. `openssl rand -hex 32`)

# 3. create the database
npx prisma db push
npm run db:seed    # optional — populates demo servers / containers / alerts

# 4. run the dashboard
npm run dev
# open http://localhost:3000
```

On first visit you'll be redirected to `/register` to create the admin
account. Subsequent visits prompt for sign-in. There is no public sign-up —
additional users must be invited (UI for that is on the roadmap).

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

**SQLite (default):**

```bash
cp .env.example .env
# set AGENT_API_KEY
docker compose up -d --build
```

The database file lives in the `homelab-data` named volume. To start fresh,
`docker compose down -v`.

**Postgres:**

```bash
cp .env.example .env
# set AGENT_API_KEY and POSTGRES_PASSWORD; set DATABASE_URL to a postgres URL
docker compose -f docker-compose.postgres.yml up -d --build
```

This brings up a `postgres:16-alpine` sidecar and a Postgres-flavoured
dashboard image. The schema is generated at build time from the SQLite
source-of-truth (`prisma/schema.prisma`) by swapping the provider — see
`scripts/gen-postgres-schema.mjs`. For local development against Postgres:

```bash
npm run db:postgres:push   # syncs schema.postgres.prisma + pushes
npm run db:postgres:generate
```

## Environment variables

| Var | Where | Description |
|-----|-------|-------------|
| `DATABASE_URL` | dashboard | Prisma connection string. Defaults to `file:./prisma/dev.db`. |
| `AGENT_API_KEY` | dashboard + agent | Shared secret sent in the `X-Agent-Key` header. |
| `NEXT_PUBLIC_APP_URL` | dashboard | Public base URL of the dashboard. |
| `DASHBOARD_URL` | agent | Base URL the agent posts to. |
| `AGENT_SERVER_NAME` | agent | Friendly name for this host (defaults to hostname). |
| `AGENT_INTERVAL_SECONDS` | agent | Reporting interval; default `30`. |

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
```

The downsample job must run before the retention job for any given hour
(retention drops raw metrics that the rollup is supposed to read). The
15-minute downsample + 3am retention schedule above gives a comfortable
margin.

The metric table grows ~1 row per server per agent tick. Without retention a
30-second interval over 5 hosts produces ~430k rows/month — SQLite will
handle it, but a daily prune keeps queries snappy.

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
- ✅ Postgres support (`docker-compose.postgres.yml` + scripts).
- ✅ Notification integrations: Discord, ntfy, generic JSON webhook.
- ✅ Downsampling for the metric table (hourly avg/max per server).
- Per-user roles (read-only viewer vs. admin).
- SMTP / email notification channel.

## Project layout

```
.
├── prisma/                 # schema + seed
├── src/
│   ├── app/                # Next.js App Router pages + API routes
│   ├── components/         # shared React components
│   └── lib/                # prisma client, auth, validation, utils
├── agent/                  # standalone Node.js agent
├── Dockerfile
├── docker-compose.yml
├── AGENTS.md
└── README.md
```

## License

MIT — do whatever, no warranty.
