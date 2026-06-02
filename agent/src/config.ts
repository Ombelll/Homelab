import "dotenv/config";
import os from "node:os";

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    console.error(`[agent] missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  dashboardUrl: required("DASHBOARD_URL", process.env.DASHBOARD_URL).replace(/\/+$/, ""),
  apiKey: required("AGENT_API_KEY", process.env.AGENT_API_KEY),
  serverName: process.env.AGENT_SERVER_NAME?.trim() || os.hostname(),
  hostname: os.hostname(),
  intervalMs:
    Math.max(5, Number.parseInt(process.env.AGENT_INTERVAL_SECONDS ?? "30", 10)) * 1000,
  // Hard ceiling on every outbound HTTP request. Node's fetch has no default
  // timeout, so a dashboard that accepts the connection but never responds
  // would hang a request forever — and a hung job-poll would silently wedge
  // container control (the poller's in-flight guard never clears). Clamped to
  // a sane range; default 15s.
  requestTimeoutMs:
    Math.max(2, Math.min(120, Number.parseInt(process.env.AGENT_REQUEST_TIMEOUT_SECONDS ?? "15", 10))) *
    1000,
};
