# Homelab Agent

Standalone Node.js process that reports host metrics and Docker container
state to the [Homelab Control Center](../README.md) dashboard.

See the project root [`AGENTS.md`](../AGENTS.md) for the full architecture
and the planned Docker control flow.

## Requirements

- Node.js 20+
- Network reachability to the dashboard URL (over VPN / LAN)
- `AGENT_API_KEY` matching the dashboard's value
- Optional: a working `docker` CLI on the host (the agent skips container
  sync gracefully when it's missing)

## Run locally

```bash
npm install
export DASHBOARD_URL="http://localhost:3000"
export AGENT_API_KEY="<same value the dashboard uses>"
npm run dev
```

You should see `[agent] starting — host=...` and then a tick every 30s.

## Production

```bash
npm install
npm run build
DASHBOARD_URL=... AGENT_API_KEY=... node dist/index.js
```

Wrap it in `systemd`, `pm2`, or a container — anything that restarts it on
failure is fine. The agent only makes outbound HTTPS requests, so it works
behind NAT.

## Environment variables

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `DASHBOARD_URL` | yes | — | Base URL of the dashboard (no trailing slash). |
| `AGENT_API_KEY` | yes | — | Shared secret sent as `X-Agent-Key`. |
| `AGENT_SERVER_NAME` | no | `os.hostname()` | Friendly name shown in the UI. |
| `AGENT_INTERVAL_SECONDS` | no | `30` | How often to report metrics. Minimum 5s. |
