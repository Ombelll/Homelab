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
};
