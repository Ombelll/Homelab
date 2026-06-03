# Agents

The Homelab Control Center is **dashboard + per-host agents**. The agent is a
small Node.js process you run on every server you want to monitor. It collects
host metrics and (optionally) Docker container state, then pushes them to the
dashboard over HTTPS.

This document describes the current implementation and the planned evolution
toward real container control.

## How an agent works today

```
+-----------------+      every N seconds       +--------------------+
|   agent (Node)  |  ───────────────────────►  |  Next.js dashboard |
+-----------------+                            +--------------------+
       │
       ├── on startup: POST /api/agent/checkin (hostname, name, IP, OS, boot, load)
       ├── every tick: POST /api/agent/report  (one unified payload — see below)
       ├── every tick: POST /api/agent/snmp    (if AGENT_SNMP_TARGET is set)
       └── every 3s:   GET  /api/agent/jobs    (poll for container actions)
```

A single `/api/agent/report` carries everything collected this tick: CPU
(incl. per-core), memory, disk %, swap, per-disk usage, network + disk-I/O
rates, ZFS pools, hwmon temperatures, process count, failed systemd units,
top processes, SMART devices, backup age, and the full `docker ps` list. The
dashboard validates it with one Zod schema and fans it out to the relevant
tables. (The older split routes — `/metrics`, `/containers`, `/disks`,
`/sensors`, `/zfs` — still exist for compatibility but the agent uses the
unified report.)

The agent **never opens a listening port**. All traffic is outbound to the
dashboard, which makes it easy to run agents behind NAT, on VPN, or in
restricted networks.

### Files

| File | Purpose |
|------|---------|
| `agent/src/index.ts` | Top-level loop: check in, tick (collect + report), SNMP, start job runner. |
| `agent/src/config.ts` | Reads env vars, fails fast on missing required ones; warns on plaintext HTTP. |
| `agent/src/collector.ts` | Cross-platform CPU (incl. per-core) / memory / disk / swap / OS / IP. |
| `agent/src/disks.ts` | Per-mount disk usage. |
| `agent/src/diskio.ts` | Disk-I/O byte rates (delta between ticks). |
| `agent/src/network.ts` | Per-interface network byte rates. |
| `agent/src/sensors.ts` | Temperatures via Linux `/sys/class/hwmon` (and Windows WMI). |
| `agent/src/zfs.ts` | ZFS pool health/usage via `zpool`. |
| `agent/src/smart.ts` | SMART device health via `smartctl`. |
| `agent/src/processes.ts` | Top processes by CPU/memory. |
| `agent/src/system.ts` | Boot time, load avg, failed units, reboot-required, backup age. |
| `agent/src/snmp.ts` | SNMP v2c polling of a managed switch (IF-MIB). |
| `agent/src/docker.ts` | Detects Docker, runs `docker ps`, parses output (`execFile`). |
| `agent/src/runner.ts` | Polls + executes container jobs, posts results. |
| `agent/src/client.ts` | Thin `fetch` wrapper that injects `X-Agent-Key` (with timeout). |
| `agent/src/http.ts` | Low-level fetch-with-timeout helper. |

## Check-in flow

1. **Startup.** The agent reads `DASHBOARD_URL` and `AGENT_API_KEY` from the
   environment. If either is missing it exits immediately.
2. **Check-in.** It POSTs to `/api/agent/checkin` with hostname, friendly
   name (`AGENT_SERVER_NAME` or the system hostname), best-effort outbound
   IPv4, an OS description (uses `/etc/os-release` on Linux when present), boot
   time, load average, and whether a reboot is required.
3. **Tick.** Every `AGENT_INTERVAL_SECONDS` (default 30s) it collects every
   metric concurrently with `Promise.allSettled` — so one flaky collector
   (a slow `df`, a missing `systemctl`) just omits its section instead of
   dropping the whole tick — then POSTs the combined payload to
   `/api/agent/report`. The dashboard diffs the container list and removes
   containers no longer present. If the report gets a `404` (the dashboard
   doesn't know this host yet), the agent re-checks-in and resends.
4. **Re-check-in.** Every 15 minutes the agent re-runs the check-in so renamed
   hostnames / new IPs propagate without a restart.
5. **SNMP (optional).** If `AGENT_SNMP_TARGET` is set, each tick also polls
   that device over SNMP v2c and POSTs interfaces to `/api/agent/snmp`.

All requests are wrapped in `safeRun()` — a failed tick logs but does not
crash the agent. Every outbound request has a hard timeout
(`AGENT_REQUEST_TIMEOUT_SECONDS`, default 15s).

## API authentication

The dashboard accepts an `X-Agent-Key` header on every `/api/agent/*` route
and rejects anything else with `401`.

The key is matched in this order:

1. The `AGENT_API_KEY` environment variable on the dashboard (constant-time
   compare). This is the MVP path — a single shared secret.
2. A SHA-256 hash lookup against the `AgentKey` table. This lets us add
   per-agent keys with rotation and revocation without redeploying.

`AgentKey.lastUsedAt` is bumped on each successful match so we can audit
which keys are still in use.

### Recommended key handling

- Generate with `openssl rand -hex 32`.
- Treat it like a database password — don't commit it, store it in a secret
  manager or a `.env` file with `0600` perms.
- Rotate periodically. Per-agent keys with revocation already exist (Settings →
  Agent API keys): mint one key per host, optionally bound to a hostname, and
  revoke a single agent without touching the others.

## Docker control flow

Container start / stop / restart and log retrieval are real — not mocked.
They flow through an authenticated job queue:

```
dashboard                                       agent on target host
─────────                                       ──────────────────
POST /api/containers/<id>/stop
  → enqueueJob(serverId, "container.stop", {dockerId})
  ← { jobId }

UI polls GET /api/jobs/<jobId>  every 1s, up to 30s

                                                GET /api/agent/jobs?hostname=…
                                                ← claims pending jobs
                                                  (status → "inflight")
                                                execFile("docker", ["stop", dockerId])
                                                POST /api/agent/jobs/<jobId>/result
                                                   { status: "done"|"error", result }

UI sees terminal status → refreshes table
```

Job types currently supported:

| type | payload | result |
|------|---------|--------|
| `container.start` | `{ dockerId }` | `{ action, dockerId }` |
| `container.stop` | `{ dockerId }` | `{ action, dockerId }` |
| `container.restart` | `{ dockerId }` | `{ action, dockerId }` |
| `container.logs` | `{ dockerId, tail }` | `{ lines: string[] }` |
| `container.logs.stream` | `{ dockerId, tail }` | chunks via separate endpoint (see below) |
| `agent.update` | `{}` | self-update: `git pull` + rebuild + restart the agent service |

`agent.update` is the agent's self-update path (triggered from Settings →
Servers). It has no `dockerId`; the agent pulls the latest code, rebuilds, and
restarts its own service. Because this runs a script as root on the host, the
agent key it authenticates with must travel over HTTPS — see the plaintext-HTTP
warning in `config.ts`.

### Streaming logs

`container.logs.stream` is long-running. Instead of a single result, the
agent spawns `docker logs -f` and POSTs output to a separate chunk endpoint:

```
agent                                              dashboard
─────                                              ─────────
spawn docker logs -f --tail N <dockerId>
on stdout/stderr → batch lines → POST /api/agent/jobs/<id>/chunk
                       { hostname, seq, lines }
                                                   ← { continue: true | false }
if continue=false → SIGTERM the docker process
                                                   ← (also returns false when
                                                      job.status == "cancel" or
                                                      != "inflight")
every 5s send empty chunk as a heartbeat so an idle stream still learns about cancel.

POST /api/agent/jobs/<id>/result on close
                       { status: "done"|"error", result }
```

On the dashboard side, the browser opens an `EventSource` against
`GET /api/jobs/<id>/stream` (SSE). When the user closes the viewer, the SSE
request aborts and the handler flips the job to `cancel` — picked up by the
agent on the next chunk post.

Empty `lines: []` payloads are treated as heartbeats and never written to
`LogChunk`, so an idle container doesn't bloat the DB.

### Safety properties of this design

- **The dashboard never touches the Docker socket directly.** Mounting
  `/var/run/docker.sock` into the dashboard would give anyone who reaches it
  root-equivalent control of the host. Only the agent on each host talks to
  Docker, and only via `docker` CLI with a fixed argv list (`execFile`, not
  `exec`) — there is no shell interpolation path from the API into the host.
- **Jobs are hostname-scoped.** When an agent posts a result it must include
  its own hostname; the API rejects the result if the job belongs to a
  different host (`/api/agent/jobs/[id]/result` returns 403).
- **Action allowlist.** Only the job types in the table above are understood
  (the `container.*` actions plus `agent.update`). Anything else returns an
  error from the agent runner; the dashboard enqueue path enforces the same
  allowlist (`src/lib/jobs.ts`).
- **Inflight jobs are reclaimable.** If an agent crashes mid-job, the
  `inflight` row is reclaimed by the next poller after 60s — no stuck jobs.
- **Duplicate enqueues collapse.** If a user spam-clicks "stop", we return
  the existing pending/inflight job instead of queueing N copies.

### Why no WebSocket / SSE

Polling is plenty for ≤ a few dozen hosts and avoids long-lived connections
that NAT'd / VPN'd networks sometimes drop. The poll interval is 3 seconds,
so the user perceives ~3–5s end-to-end latency for an action — fine for a
homelab.

## Safe development rules

When extending the agent / dashboard:

1. **Validate every incoming agent payload** with the Zod schemas in
   `src/lib/validation.ts`. Never trust raw JSON from the network — even from
   an authenticated agent (an attacker who steals a key shouldn't be able to
   crash the dashboard with malformed input).
2. **Never log secrets.** `AGENT_API_KEY` must not appear in logs, error
   messages, or HTTP responses. Use the masked rendering in
   `src/app/settings/page.tsx` as a reference.
3. **Use Prisma's parameterised queries.** Don't string-concat into
   `$queryRaw` unless you have a hard reason and you've sanitised inputs.
4. **Keep agent dependencies minimal.** The agent ships to every host you own;
   each extra package is more attack surface. Prefer Node built-ins.
5. **Fail closed.** If we can't determine auth, status, or a permission, deny
   the action and return a structured error. No silent fall-throughs.
6. **No shell injection.** When the agent shells out (Docker / df / wmic) it
   must use fixed argument lists. Never interpolate untrusted strings into a
   command.
