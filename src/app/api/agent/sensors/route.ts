import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { sensorSyncSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await verifyAgentKey(request))) return unauthorized();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = sensorSyncSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const server = await prisma.server.findUnique({ where: { hostname: parsed.data.hostname } });
  if (!server) {
    return NextResponse.json({ error: "unknown server" }, { status: 404 });
  }

  const incoming = new Set(parsed.data.sensors.map((s) => s.name));

  await prisma.$transaction([
    ...parsed.data.sensors.map((s) =>
      prisma.sensor.upsert({
        where: { serverId_name: { serverId: server.id, name: s.name } },
        update: { kind: s.kind, value: s.value, unit: s.unit },
        create: { serverId: server.id, name: s.name, kind: s.kind, value: s.value, unit: s.unit },
      }),
    ),
    prisma.sensor.deleteMany({
      where: { serverId: server.id, name: { notIn: Array.from(incoming) } },
    }),
  ]);

  return NextResponse.json({ ok: true, count: parsed.data.sensors.length });
}
