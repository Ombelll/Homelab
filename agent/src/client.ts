import { config } from "./config.js";

async function post(path: string, body: unknown) {
  const url = `${config.dashboardUrl}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

export const api = {
  checkin: (payload: {
    hostname: string;
    name?: string;
    ipAddress?: string;
    os?: string;
  }) => post("/api/agent/checkin", payload),

  metrics: (payload: {
    hostname: string;
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
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
};
