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
       ├── on startup: POST /api/agent/checkin   (hostname, name, IP, OS)
       ├── every tick: POST /api/agent/metrics   (cpu%, mem%, disk%)
       └── every tick: POST /api/agent/containers (full docker ps list)
```

The agent **never opens a listening port**. All traffic is outbound to the
dashboard, which makes it easy to run agents behind NAT, on VPN, or in
restricted networks.

### Files

| File | Purpose |
|------|---------|
| `agent/src/index.ts` | Top-level loop: check in, then tick on an interval. |
| `agent/src/config.ts` | Reads env vars, fails fast on missing required ones. |
| `agent/src/collector.ts` | Cross-platform CPU / memory / disk / OS / IP collection. |
| `agent/src/docker.ts` | Detects Docker, runs `docker ps`, parses output. |
| `agent/src/client.ts` | Thin `fetch` wrapper that injects `X-Agent-Key`. |

## Check-in flow

1. **Startup.** The agent reads `DASHBOARD_URL` and `AGENT_API_KEY` from the
   environment. If either is missing it exits immediately.
2. **Check-in.** It POSTs to `/api/agent/checkin` with hostname, friendly
   name (`AGENT_SERVER_NAME` or the system hostname), best-effort outbound
   IPv4, and an OS description (uses `/etc/os-release` on Linux when present).
3. **Tick.** Every `AGENT_INTERVAL_SECONDS` (default 30s):
   - Samples CPU usage by reading `os.cpus()` 1s apart and diffing the idle
     bucket against the total. This is portable; it just requires a small
     sleep per sample.
   - Reads memory from `os.totalmem()` / `os.freemem()`.
   - Reads disk usage of `/` via `df -kP` (Linux/macOS) or `wmic` (Windows).
     If neither is available the agent reports `0`.
   - If `docker` is on PATH, runs `docker ps -a --format "{{json .}}"`,
     parses each line, and POSTs the full list to `/api/agent/containers`.
     The dashboard performs a diff and removes containers no longer present.
4. **Re-check-in.** Every 15 minutes the agent re-runs the check-in so renamed
   hostnames / new IPs propagate without a restart.

All requests are wrapped in `safeRun()` — a failed tick logs but does not
crash the agent.

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
- Rotate periodically; for now rotation means updating the env var on both
  ends. Per-agent keys (with overlap windows) are on the roadmap.

## Future Docker control flow

The dashboard exposes `POST /api/containers/[id]/{start,stop,restart}` and a
GET `/api/containers/[id]/logs` route. **In MVP they update DB state and
return a mock job id** — they do not actually run anything against Docker.

The planned design when we go live:

```
dashboard                                 agent on target host
─────────                                 ──────────────────
POST /api/containers/<id>/stop
  → enqueue job(serverId, containerDockerId, "stop")

(agent long-polls or holds an SSE/WebSocket open)
                          ◄── job push ──
                                          run `docker stop <dockerId>`
                                          (uses local Docker socket — never
                                           exposed to the dashboard)
                          ── result ──►
  → mark job done, refresh container row
```

Key principles:

- **The dashboard never touches the Docker socket directly.** Mounting
  `/var/run/docker.sock` into the dashboard would give anyone who reaches
  the dashboard root-equivalent control of the host. The agent is the only
  thing that talks to Docker, and the agent only runs on the host it manages.
- **Jobs are signed and scoped.** A job for `serverId=A` is only fulfilled by
  the agent that owns hostname A. Replays beyond a short TTL are rejected.
- **Allowed actions are an explicit allowlist** (`start`, `stop`, `restart`,
  `logs:tail`). Free-form shell exec is *not* on the table.

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
