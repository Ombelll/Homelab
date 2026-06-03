import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { evaluateMetricAlerts } from "@/lib/alerts";

/**
 * End-to-end exercise of the alert engine against a real DB. Confirms the
 * sustained-N-samples opening rule, single-sample resolution, severity
 * upgrade in place, and maintenance-window suppression.
 */

async function reset() {
  await prisma.$transaction([
    prisma.alert.deleteMany(),
    prisma.metric.deleteMany(),
    prisma.maintenanceWindow.deleteMany(),
    prisma.server.deleteMany(),
  ]);
}

async function makeServer() {
  return prisma.server.create({
    data: { name: "alpha", hostname: `alpha-${Date.now()}.test`, status: "online" },
  });
}

async function writeMetric(serverId: string, cpu: number) {
  await prisma.metric.create({
    data: { serverId, cpuPercent: cpu, memoryPercent: 10, diskPercent: 10 },
  });
}

async function openCpuAlerts(serverId: string) {
  return prisma.alert.findMany({
    where: { serverId, type: "cpu-high", resolved: false },
  });
}

describe.skipIf(process.env.INTEGRATION_DB_READY !== "1")("alert engine (integration)", () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("does NOT open an alert from a single high sample", async () => {
    const s = await makeServer();
    await writeMetric(s.id, 90);
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 90,
      memoryPercent: 10,
      diskPercent: 10,
    });
    expect(await openCpuAlerts(s.id)).toHaveLength(0);
  });

  it("opens a warning alert after 3 sustained high samples", async () => {
    const s = await makeServer();
    for (const v of [90, 90, 90]) {
      await writeMetric(s.id, v);
    }
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 90,
      memoryPercent: 10,
      diskPercent: 10,
    });
    const open = await openCpuAlerts(s.id);
    expect(open).toHaveLength(1);
    expect(open[0].severity).toBe("warning");
  });

  it("upgrades severity to critical when the value crosses 95", async () => {
    const s = await makeServer();
    for (const v of [90, 90, 90]) await writeMetric(s.id, v);
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 90,
      memoryPercent: 10,
      diskPercent: 10,
    });
    expect((await openCpuAlerts(s.id))[0].severity).toBe("warning");

    await writeMetric(s.id, 97);
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 97,
      memoryPercent: 10,
      diskPercent: 10,
    });
    expect((await openCpuAlerts(s.id))[0].severity).toBe("critical");
  });

  it("resolves on a single below-warning sample (hysteresis through sustain on open)", async () => {
    const s = await makeServer();
    for (const v of [90, 90, 90]) await writeMetric(s.id, v);
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 90,
      memoryPercent: 10,
      diskPercent: 10,
    });
    expect(await openCpuAlerts(s.id)).toHaveLength(1);

    await writeMetric(s.id, 50);
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 50,
      memoryPercent: 10,
      diskPercent: 10,
    });
    expect(await openCpuAlerts(s.id)).toHaveLength(0);
  });

  it("respects an active maintenance window (no new alert opens)", async () => {
    const s = await makeServer();
    await prisma.maintenanceWindow.create({
      data: {
        serverId: s.id,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
        reason: "smoke test",
      },
    });

    for (const v of [90, 90, 90]) await writeMetric(s.id, v);
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 90,
      memoryPercent: 10,
      diskPercent: 10,
    });
    expect(await openCpuAlerts(s.id)).toHaveLength(0);
  });

  it("ignores an expired maintenance window", async () => {
    const s = await makeServer();
    await prisma.maintenanceWindow.create({
      data: {
        serverId: s.id,
        startsAt: new Date(Date.now() - 2 * 60 * 60_000),
        endsAt: new Date(Date.now() - 60 * 60_000),
        reason: "smoke test",
      },
    });

    for (const v of [90, 90, 90]) await writeMetric(s.id, v);
    await evaluateMetricAlerts({
      serverId: s.id,
      serverName: s.name,
      cpuPercent: 90,
      memoryPercent: 10,
      diskPercent: 10,
    });
    expect(await openCpuAlerts(s.id)).toHaveLength(1);
  });
});
