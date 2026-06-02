import { config } from "./config.js";
import { fetchWithTimeout } from "./http.js";

// HTTP error carrying the status so callers can branch (e.g. re-checkin on 404).
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function postOnce(path: string, body: string) {
  const res = await fetchWithTimeout(`${config.dashboardUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-key": config.apiKey },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`POST ${path} -> ${res.status} ${text.slice(0, 200)}`, res.status);
  }
  return res.json().catch(() => ({}));
}

/**
 * POST with one retry on transient failures — a network error/timeout or a
 * 5xx (dashboard restarting). 4xx are semantic (bad key, unknown server) and
 * are surfaced immediately without a pointless retry.
 */
async function post(path: string, body: unknown) {
  const payload = JSON.stringify(body);
  try {
    return await postOnce(path, payload);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    const transient = status === 0 || status >= 500;
    if (!transient) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return await postOnce(path, payload);
  }
}

export const api = {
  checkin: (payload: {
    hostname: string;
    name?: string;
    ipAddress?: string;
    os?: string;
    bootAt?: string;
    loadAvg?: [number, number, number];
    rebootRequired?: boolean;
  }) => post("/api/agent/checkin", payload),

  // Combined per-tick report — replaces the separate metrics/containers/
  // disks/sensors/zfs calls. Optional sections are omitted when a collector
  // failed this tick.
  report: (payload: {
    hostname: string;
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
    swapPercent?: number;
    cpuPerCore?: number[];
    processCount?: number;
    failedUnits?: number;
    networkRates?: Array<{ iface: string; rxBps: number; txBps: number }>;
    diskIoRates?: Array<{ device: string; readBps: number; writeBps: number }>;
    topProcesses?: Array<{ pid: number; name: string; cpuPercent: number; memBytes: number }>;
    smartDevices?: Array<{
      device: string;
      model?: string;
      serial?: string;
      healthy: boolean;
      tempC?: number;
      powerOnHours?: number;
      reallocatedSectors?: number;
      wearPercent?: number;
    }>;
    containers?: unknown[];
    disks?: unknown[];
    sensors?: unknown[];
    zfsPools?: unknown[];
  }) => post("/api/agent/report", payload),

  metrics: (payload: {
    hostname: string;
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
    networkRates?: Array<{ iface: string; rxBps: number; txBps: number }>;
  }) => post("/api/agent/metrics", payload),

  containers: (payload: {
    hostname: string;
    containers: Array<{
      dockerId: string;
      name: string;
      image: string;
      imageDigest?: string;
      status: string;
      ports: Array<{ host?: string; container: string; protocol?: string }>;
      composeProject?: string;
      composeService?: string;
      cpuPercent?: number;
      memoryBytes?: number;
      memoryLimitBytes?: number;
      restartCount?: number;
    }>;
  }) => post("/api/agent/containers", payload),

  disks: (payload: {
    hostname: string;
    disks: Array<{
      mountpoint: string;
      fstype?: string;
      totalBytes: number;
      usedBytes: number;
    }>;
  }) => post("/api/agent/disks", payload),

  sensors: (payload: {
    hostname: string;
    sensors: Array<{ name: string; kind: string; value: number; unit: string }>;
  }) => post("/api/agent/sensors", payload),

  zfs: (payload: {
    hostname: string;
    pools: Array<{ name: string; health: string; totalBytes: number; usedBytes: number; lastScrubAt?: string }>;
  }) => post("/api/agent/zfs", payload),
};
