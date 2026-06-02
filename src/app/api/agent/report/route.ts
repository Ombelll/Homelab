import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { reportSchema } from "@/lib/validation";
import { evaluateMetricAlerts } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/**
 * Combined per-tick ingest. The agent sends one report covering metrics,
 * network/disk I/O rates, containers, disks, sensors and ZFS pools instead of
 * five separate POSTs. Each section is optional; a section the agent couldn't
 * collect this tick is simply absent and left untouched here.
 *
 * The 404 ("unknown server") response is the agent's cue to re-check-in
 * immediately rather than waiting for the periodic re-checkin.
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!(await verifyAgentKey(request, { hostname: parsed.data.hostname }))) {
    return unauthorized();
  }

  const d = parsed.data;
  const server = await prisma.server.findUnique({ where: { hostname: d.hostname } });
  if (!server) {
    return NextResponse.json(
      { error: "unknown server, call /api/agent/checkin first" },
      { status: 404 },
    );
  }
  const serverId = server.id;
  const status = deriveStatus(d.cpuPercent, d.memoryPercent, d.diskPercent);

  // One transaction so a tick lands atomically.
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.metric.create({
      data: {
        serverId,
        cpuPercent: d.cpuPercent,
        memoryPercent: d.memoryPercent,
        diskPercent: d.diskPercent,
        swapPercent: d.swapPercent ?? null,
        cpuPerCore: d.cpuPerCore ? JSON.stringify(d.cpuPerCore) : null,
        processCount: d.processCount ?? null,
        failedUnits: d.failedUnits ?? null,
      },
    }),
    prisma.server.update({
      where: { id: serverId },
      data: {
        status,
        lastSeenAt: new Date(),
        ...(d.networkRates ? { networkRates: JSON.stringify(d.networkRates) } : {}),
        ...(d.diskIoRates ? { diskIoRates: JSON.stringify(d.diskIoRates) } : {}),
      },
    }),
  ];

  if (d.containers) {
    const ids = new Set(d.containers.map((c) => c.dockerId));
    const now = new Date();
    for (const c of d.containers) {
      const hasStats = c.cpuPercent != null || c.memoryBytes != null;
      const stats = hasStats
        ? {
            cpuPercent: c.cpuPercent ?? null,
            memoryBytes: c.memoryBytes ?? null,
            memoryLimitBytes: c.memoryLimitBytes ?? null,
            statsAt: now,
          }
        : {};
      const base = {
        name: c.name,
        image: c.image,
        imageDigest: c.imageDigest ?? null,
        status: c.status,
        ports: JSON.stringify(c.ports),
        composeProject: c.composeProject ?? null,
        composeService: c.composeService ?? null,
        restartCount: c.restartCount ?? null,
        ...stats,
      };
      ops.push(
        prisma.container.upsert({
          where: { serverId_dockerId: { serverId, dockerId: c.dockerId } },
          update: base,
          create: { serverId, dockerId: c.dockerId, ...base },
        }),
      );
    }
    ops.push(
      prisma.container.deleteMany({
        where: { serverId, dockerId: { notIn: Array.from(ids) } },
      }),
    );
  }

  if (d.disks) {
    const mounts = new Set(d.disks.map((x) => x.mountpoint));
    for (const x of d.disks) {
      ops.push(
        prisma.disk.upsert({
          where: { serverId_mountpoint: { serverId, mountpoint: x.mountpoint } },
          update: { fstype: x.fstype ?? null, totalBytes: x.totalBytes, usedBytes: x.usedBytes },
          create: {
            serverId,
            mountpoint: x.mountpoint,
            fstype: x.fstype ?? null,
            totalBytes: x.totalBytes,
            usedBytes: x.usedBytes,
          },
        }),
      );
    }
    ops.push(
      prisma.disk.deleteMany({ where: { serverId, mountpoint: { notIn: Array.from(mounts) } } }),
    );
  }

  if (d.sensors) {
    const names = new Set(d.sensors.map((s) => s.name));
    for (const s of d.sensors) {
      ops.push(
        prisma.sensor.upsert({
          where: { serverId_name: { serverId, name: s.name } },
          update: { kind: s.kind, value: s.value, unit: s.unit },
          create: { serverId, name: s.name, kind: s.kind, value: s.value, unit: s.unit },
        }),
      );
    }
    ops.push(
      prisma.sensor.deleteMany({ where: { serverId, name: { notIn: Array.from(names) } } }),
    );
  }

  if (d.zfsPools) {
    const names = new Set(d.zfsPools.map((p) => p.name));
    for (const p of d.zfsPools) {
      const fields = {
        health: p.health,
        totalBytes: p.totalBytes,
        usedBytes: p.usedBytes,
        lastScrubAt: p.lastScrubAt ? new Date(p.lastScrubAt) : null,
      };
      ops.push(
        prisma.zfsPool.upsert({
          where: { serverId_name: { serverId, name: p.name } },
          update: fields,
          create: { serverId, name: p.name, ...fields },
        }),
      );
    }
    ops.push(
      prisma.zfsPool.deleteMany({ where: { serverId, name: { notIn: Array.from(names) } } }),
    );
  }

  await prisma.$transaction(ops);

  await evaluateMetricAlerts({
    serverId,
    serverName: server.name,
    cpuPercent: d.cpuPercent,
    memoryPercent: d.memoryPercent,
    diskPercent: d.diskPercent,
  });

  return NextResponse.json({ ok: true, status });
}

function deriveStatus(cpu: number, mem: number, disk: number) {
  if (cpu >= 95 || mem >= 95 || disk >= 95) return "critical";
  if (cpu >= 80 || mem >= 85 || disk >= 85) return "warning";
  return "online";
}
