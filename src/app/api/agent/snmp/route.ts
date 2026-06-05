import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { snmpReportSchema } from "@/lib/validation";
import { notifyAlert } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// New errors+discards on a single up-port within one poll interval that we
// consider worth alerting on (a flaky cable / failing transceiver). A healthy
// LAN link increments these essentially never.
const PORT_ERR_THRESHOLD = 10;

const errTotal = (p: {
  inErrors?: number | null;
  outErrors?: number | null;
  inDiscards?: number | null;
  outDiscards?: number | null;
}) => (p.inErrors ?? 0) + (p.outErrors ?? 0) + (p.inDiscards ?? 0) + (p.outDiscards ?? 0);

/**
 * Ingest an SNMP poll of a network device (managed switch) from an agent.
 * The agent walks IF-MIB and reports per-port status + throughput; we upsert
 * the device and its ports, deleting ports that disappeared from the poll.
 *
 * Auth uses the shared agent key (env-key path). No hostname binding here —
 * the "host" in the body is the polled switch, not the reporting agent.
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = snmpReportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!(await verifyAgentKey(request))) return unauthorized();

  const d = parsed.data;
  const now = new Date();

  const device = await prisma.networkDevice.upsert({
    where: { host: d.host },
    update: { name: d.name, vendor: d.vendor ?? null, uptimeSec: d.uptimeSec ?? null, lastSeenAt: now },
    create: {
      host: d.host,
      name: d.name,
      vendor: d.vendor ?? null,
      uptimeSec: d.uptimeSec ?? null,
      lastSeenAt: now,
    },
  });

  // Previous counters, to turn the cumulative error/discard totals into a
  // per-interval delta (what actually indicates a problem right now).
  const prev = await prisma.networkPort.findMany({
    where: { deviceId: device.id },
    select: { ifIndex: true, inErrors: true, outErrors: true, inDiscards: true, outDiscards: true },
  });
  const prevByIdx = new Map(prev.map((p) => [p.ifIndex, p]));

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const indexes = new Set(d.ports.map((p) => p.ifIndex));
  const badPorts: { name: string; delta: number }[] = [];

  for (const p of d.ports) {
    const old = prevByIdx.get(p.ifIndex);
    // First sighting → no baseline → null. Counter reset (new < old) → 0.
    let errDelta: number | null = null;
    if (old) {
      const diff = errTotal(p) - errTotal(old);
      errDelta = diff >= 0 ? diff : 0;
    }
    if (p.status === "up" && errDelta != null && errDelta >= PORT_ERR_THRESHOLD) {
      badPorts.push({ name: p.name, delta: errDelta });
    }

    const fields = {
      name: p.name,
      status: p.status,
      adminUp: p.adminUp ?? null,
      speedMbps: p.speedMbps ?? null,
      rxBps: p.rxBps ?? null,
      txBps: p.txBps ?? null,
      inErrors: p.inErrors ?? null,
      outErrors: p.outErrors ?? null,
      inDiscards: p.inDiscards ?? null,
      outDiscards: p.outDiscards ?? null,
      errDelta,
    };
    ops.push(
      prisma.networkPort.upsert({
        where: { deviceId_ifIndex: { deviceId: device.id, ifIndex: p.ifIndex } },
        update: fields,
        create: { deviceId: device.id, ifIndex: p.ifIndex, ...fields },
      }),
    );
  }
  ops.push(
    prisma.networkPort.deleteMany({
      where: { deviceId: device.id, ifIndex: { notIn: Array.from(indexes) } },
    }),
  );
  // Total-throughput history point (summed across ports) for the traffic spark.
  const totRx = d.ports.reduce((a, p) => a + (p.rxBps ?? 0), 0);
  const totTx = d.ports.reduce((a, p) => a + (p.txBps ?? 0), 0);
  ops.push(
    prisma.networkDeviceSample.create({ data: { deviceId: device.id, rxBps: totRx, txBps: totTx } }),
  );
  await prisma.$transaction(ops);

  // Service-scoped alert (serverId null) for ports racking up errors/discards.
  const open = await prisma.alert.findFirst({
    where: { resolved: false, type: "switch-port-errors", message: { contains: d.host } },
  });
  if (badPorts.length > 0) {
    const message = `Switch ${d.name} (${d.host}) port errors: ${badPorts
      .map((b) => `${b.name} +${b.delta}`)
      .join(", ")}`;
    if (!open) {
      const created = await prisma.alert.create({
        data: { serverId: null, type: "switch-port-errors", severity: "warning", message },
      });
      void notifyAlert({
        type: created.type,
        severity: created.severity,
        message: created.message,
        serverName: d.name,
        createdAt: created.createdAt,
      });
    } else {
      await prisma.alert.update({ where: { id: open.id }, data: { message } });
    }
  } else if (open) {
    await prisma.alert.update({ where: { id: open.id }, data: { resolved: true, resolvedAt: new Date() } });
  }

  return NextResponse.json({ ok: true, ports: d.ports.length });
}
