import { config } from "./config.js";
import { api, ApiError } from "./client.js";
import {
  getCpuPercent,
  getCpuPerCore,
  getDiskPercent,
  getIpAddress,
  getMemoryPercent,
  getOsDescription,
  getSwapPercent,
} from "./collector.js";
import { listDockerContainers } from "./docker.js";
import { getDisks } from "./disks.js";
import { getSensors } from "./sensors.js";
import {
  getBootAt,
  getBackupInfo,
  getFailedUnits,
  getLoadAvg,
  getProcessCount,
  getRebootRequired,
} from "./system.js";
import { getNetworkRates } from "./network.js";
import { getDiskIoRates } from "./diskio.js";
import { getTopProcesses } from "./processes.js";
import { getSmartDevices } from "./smart.js";
import { getSnmpDevice } from "./snmp.js";
import { getRouterStats } from "./router.js";
import { getLatestSpeedtest } from "./speedtest.js";
import { getUps } from "./ups.js";
import { getPowerWatts } from "./power.js";
import { getLogs } from "./logs.js";
import { getZfsPools } from "./zfs.js";
import { getClusterInfo } from "./cluster.js";
import { getPbsInfo } from "./pbs.js";
import { startJobRunner } from "./runner.js";

let dockerWarned = false;

async function checkin() {
  const [osDesc, rebootRequired] = await Promise.all([
    getOsDescription(),
    getRebootRequired(),
  ]);
  await api.checkin({
    hostname: config.hostname,
    name: config.serverName,
    ipAddress: getIpAddress(),
    os: osDesc,
    bootAt: getBootAt(),
    loadAvg: getLoadAvg(),
    rebootRequired,
  });
}

async function tick() {
  // Collect everything concurrently and tolerate individual failures — a
  // collector that throws (a flaky `df`, missing systemctl) just leaves its
  // section out of the report instead of dropping the whole tick.
  const settled = await Promise.allSettled([
    getCpuPercent(), //        0
    getCpuPerCore(), //        1
    getDiskPercent(), //       2
    listDockerContainers(), // 3
    getDisks(), //             4
    getSensors(), //           5
    getNetworkRates(), //      6
    getZfsPools(), //          7
    getSwapPercent(), //       8
    getProcessCount(), //      9
    getFailedUnits(), //      10
    getDiskIoRates(), //      11
    getTopProcesses(), //     12
    getSmartDevices(), //     13
    getBackupInfo(), //       14
    getUps(), //              15
    getPowerWatts(), //       16
    getClusterInfo(), //      17
    getPbsInfo(), //          18
  ]);
  const val = <T>(i: number, fallback: T): T =>
    settled[i].status === "fulfilled"
      ? (settled[i] as PromiseFulfilledResult<T>).value
      : fallback;

  const containers = val<Awaited<ReturnType<typeof listDockerContainers>>>(3, null);
  const nonEmpty = <T>(a: T[]): T[] | undefined => (a.length > 0 ? a : undefined);

  const payload = {
    hostname: config.hostname,
    cpuPercent: round(val(0, 0)),
    memoryPercent: round(getMemoryPercent()),
    diskPercent: round(val(2, 0)),
    swapPercent: optRound(val<number | undefined>(8, undefined)),
    cpuPerCore: nonEmpty(val<number[]>(1, []).map(round)),
    processCount: val<number | undefined>(9, undefined),
    failedUnits: val<number | undefined>(10, undefined),
    networkRates: nonEmpty(val(6, [])),
    diskIoRates: nonEmpty(val(11, [])),
    topProcesses: nonEmpty(val(12, [])),
    smartDevices: nonEmpty(val(13, [])),
    backupAgeHours: val<{ ageHours: number; bytes?: number } | undefined>(14, undefined)?.ageHours,
    backupBytes: val<{ ageHours: number; bytes?: number } | undefined>(14, undefined)?.bytes,
    ups: val<Awaited<ReturnType<typeof getUps>>>(15, undefined),
    powerWatts: val<number | undefined>(16, undefined),
    containers: containers ?? undefined,
    disks: nonEmpty(val(4, [])),
    sensors: nonEmpty(val(5, [])),
    zfsPools: nonEmpty(val(7, [])),
    cluster: val<Awaited<ReturnType<typeof getClusterInfo>>>(17, undefined),
    pbs: val<Awaited<ReturnType<typeof getPbsInfo>>>(18, undefined),
  };

  try {
    await api.report(payload);
  } catch (err) {
    // 404 = the dashboard doesn't know this host (restarted DB / never
    // registered). Re-check-in right away and resend, instead of waiting for
    // the 15-minute periodic checkin.
    if (err instanceof ApiError && err.status === 404) {
      await checkin();
      await api.report(payload);
    } else {
      throw err;
    }
  }

  if (containers === null && !dockerWarned) {
    console.log("[agent] docker not detected on this host — skipping container sync");
    dockerWarned = true;
  }
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}

function optRound(n: number | undefined) {
  return n == null ? undefined : round(n);
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

  // Optional: poll an SNMP device (managed switch) on the same cadence as
  // metrics. Dormant unless AGENT_SNMP_TARGET is set.
  if (config.snmpTarget) {
    console.log(`[agent] SNMP polling enabled — target=${config.snmpTarget}`);
    await safeRun(snmpTick, "snmp");
    setInterval(() => safeRun(snmpTick, "snmp"), config.intervalMs);
  }

  // Optional: SSH-poll an OpenWrt/GL.iNet router on the metrics cadence.
  // Dormant unless AGENT_ROUTER_SSH is set (only on the host whose key it trusts).
  if (config.routerSshTarget) {
    console.log(`[agent] router SSH polling enabled — target=${config.routerSshTarget}`);
    await safeRun(routerTick, "router");
    setInterval(() => safeRun(routerTick, "router"), config.intervalMs);
  }

  // Optional: read the latest internet speed test every 5 minutes (the tracker
  // runs tests on its own schedule; we just surface the newest). Dormant unless
  // AGENT_SPEEDTEST_CONTAINER is set.
  if (config.speedtestContainer) {
    console.log(`[agent] speedtest reading enabled — container=${config.speedtestContainer}`);
    await safeRun(speedtestTick, "speedtest");
    setInterval(() => safeRun(speedtestTick, "speedtest"), 5 * 60 * 1000);
  }

  // Ship warn/error logs (host journal + container logs) every 5 minutes for
  // after-the-fact searching in the dashboard.
  await safeRun(logsTick, "logs");
  setInterval(() => safeRun(logsTick, "logs"), 5 * 60 * 1000);
}

async function speedtestTick() {
  const result = await getLatestSpeedtest();
  if (result) await api.reportSpeedtest(result);
}

async function snmpTick() {
  const device = await getSnmpDevice();
  if (device) await api.reportSnmp(device);
}

async function routerTick() {
  const stats = await getRouterStats();
  if (stats) await api.reportRouter(stats);
}

async function logsTick() {
  const containers = await listDockerContainers();
  const names = containers ? containers.map((c) => c.name).filter(Boolean) : null;
  const lines = await getLogs(names);
  if (lines.length) await api.reportLogs({ hostname: config.hostname, lines });
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
