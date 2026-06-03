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
import { getZfsPools } from "./zfs.js";
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
    containers: containers ?? undefined,
    disks: nonEmpty(val(4, [])),
    sensors: nonEmpty(val(5, [])),
    zfsPools: nonEmpty(val(7, [])),
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
}

async function snmpTick() {
  const device = await getSnmpDevice();
  if (device) await api.reportSnmp(device);
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
