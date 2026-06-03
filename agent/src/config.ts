import "dotenv/config";
import os from "node:os";

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    console.error(`[agent] missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const dashboardUrl = required("DASHBOARD_URL", process.env.DASHBOARD_URL).replace(/\/+$/, "");

// The agent key travels in an x-agent-key header and the dashboard can hand
// back an `agent.update` job that runs a script as root. Over plaintext HTTP
// to a non-loopback host, an on-path attacker on the LAN can sniff the key and
// forge that job. Warn loudly (don't hard-fail — local/LAN setups are common
// and the operator may accept the risk); prefer the tailnet HTTPS URL.
try {
  const u = new URL(dashboardUrl);
  const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (u.protocol === "http:" && !isLoopback) {
    console.warn(
      `[agent] WARNING: DASHBOARD_URL is plaintext HTTP (${u.host}). The agent key and ` +
        `self-update jobs are exposed to on-path attackers. Use the HTTPS/tailnet URL.`,
    );
  }
} catch {
  console.error(`[agent] DASHBOARD_URL is not a valid URL: ${dashboardUrl}`);
  process.exit(1);
}

export const config = {
  dashboardUrl,
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

  // Optional SNMP polling of a network device (managed switch). DORMANT unless
  // AGENT_SNMP_TARGET is set — then this agent polls that IP over SNMP v2c each
  // tick and reports its interfaces to /api/agent/snmp.
  snmpTarget: process.env.AGENT_SNMP_TARGET?.trim() || undefined,
  snmpCommunity: process.env.AGENT_SNMP_COMMUNITY?.trim() || "public",
};
