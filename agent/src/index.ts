import { config } from "./config.js";
import { api } from "./client.js";
import {
  getCpuPercent,
  getDiskPercent,
  getIpAddress,
  getMemoryPercent,
  getOsDescription,
} from "./collector.js";
import { listDockerContainers } from "./docker.js";
import { startJobRunner } from "./runner.js";

let dockerWarned = false;

async function checkin() {
  const osDesc = await getOsDescription();
  await api.checkin({
    hostname: config.hostname,
    name: config.serverName,
    ipAddress: getIpAddress(),
    os: osDesc,
  });
}

async function tick() {
  const [cpu, disk, containers] = await Promise.all([
    getCpuPercent(),
    getDiskPercent(),
    listDockerContainers(),
  ]);
  const mem = getMemoryPercent();

  await api.metrics({
    hostname: config.hostname,
    cpuPercent: round(cpu),
    memoryPercent: round(mem),
    diskPercent: round(disk),
  });

  if (containers) {
    await api.containers({ hostname: config.hostname, containers });
  } else if (!dockerWarned) {
    console.log("[agent] docker not detected on this host — skipping container sync");
    dockerWarned = true;
  }
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}

async function main() {
  console.log(
    `[agent] starting — host=${config.hostname} dashboard=${config.dashboardUrl} interval=${
      config.intervalMs / 1000
    }s`,
  );

  await safeRun(checkin, "checkin");
  await safeRun(tick, "tick");

  setInterval(() => safeRun(tick, "tick"), config.intervalMs);

  // Periodically re-check in so renamed hostnames / new IPs propagate.
  setInterval(() => safeRun(checkin, "checkin"), 15 * 60 * 1000);

  // Start polling the dashboard for jobs (container start/stop/restart/logs).
  startJobRunner();
  console.log("[agent] job runner started — polling every 3s");
}

async function safeRun(fn: () => Promise<void>, label: string) {
  try {
    await fn();
  } catch (err) {
    console.error(`[agent] ${label} failed:`, (err as Error).message);
  }
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
