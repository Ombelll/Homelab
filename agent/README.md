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
| `AGENT_REQUEST_TIMEOUT_SECONDS` | no | `15` | Hard timeout on every outbound HTTP request to the dashboard. Clamped to 2–120s. |

## Platform support

| Platform | CPU/Mem/Disk | Per-disk | Sensors | Docker |
|----------|:------------:|:--------:|:-------:|:------:|
| Linux (x86_64, arm64) | ✅ | ✅ (`df`) | ✅ (`/sys/class/hwmon`) | ✅ |
| Windows 10 / 11 | ✅ | ✅ (PowerShell `Get-Volume`, falls back to `wmic`) | optional ⓘ | ✅ (Docker Desktop) |
| macOS | ✅ | ✅ (`df`) | ❌ | ✅ (Docker Desktop) |

ⓘ **Windows sensors** require [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
or [OpenHardwareMonitor](https://openhardwaremonitor.org/) to be running
(typically as a service, elevated). The agent queries their WMI namespace.
If neither is running we silently report no sensors.

### Running on Windows as a service

The simplest reliable wrapper is [NSSM](https://nssm.cc/):

```powershell
nssm install homelab-agent "C:\Program Files\nodejs\node.exe" `
  "C:\path\to\Homelab\agent\node_modules\tsx\dist\cli.mjs" "src\index.ts"
nssm set homelab-agent AppDirectory "C:\path\to\Homelab\agent"
nssm set homelab-agent AppEnvironmentExtra `
  DASHBOARD_URL=http://homelab.lan:3000 AGENT_API_KEY=<key>
nssm start homelab-agent
```

For sensor data: install LibreHardwareMonitor, enable "Run on Windows
startup" + "Run As Administrator" in its options, and tick "Web Server".
The WMI namespace appears as soon as it's running.

### Raspberry Pi (any model)

The agent itself is happy on a Pi — only ~30 MB RAM, no special builds.
Use `arm64` Node binaries. Disk usage uses `df`, sensors uses
`/sys/class/hwmon`. For a Pi specifically you also get the SoC
temperature exposed at `/sys/class/thermal/thermal_zone0/temp` — that's
not read by the agent today (it sticks to hwmon for consistency); add
it locally if you want it.
