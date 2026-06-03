import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { snmpReportSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

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

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const indexes = new Set(d.ports.map((p) => p.ifIndex));
  for (const p of d.ports) {
    const fields = {
      name: p.name,
      status: p.status,
      rxBps: p.rxBps ?? null,
      txBps: p.txBps ?? null,
      inErrors: p.inErrors ?? null,
      outErrors: p.outErrors ?? null,
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
  await prisma.$transaction(ops);

  return NextResponse.json({ ok: true, ports: d.ports.length });
}
