import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { containerSyncSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = containerSyncSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!(await verifyAgentKey(request, { hostname: parsed.data.hostname }))) {
    return unauthorized();
  }

  const { hostname, containers } = parsed.data;

  const server = await prisma.server.findUnique({ where: { hostname } });
  if (!server) {
    return NextResponse.json(
      { error: "unknown server, call /api/agent/checkin first" },
      { status: 404 },
    );
  }

  const incomingIds = new Set(containers.map((c) => c.dockerId));
  const now = new Date();

  await prisma.$transaction([
    ...containers.map((c) => {
      const hasStats = c.cpuPercent != null || c.memoryBytes != null;
      const statsFields = hasStats
        ? {
            cpuPercent: c.cpuPercent ?? null,
            memoryBytes: c.memoryBytes ?? null,
            memoryLimitBytes: c.memoryLimitBytes ?? null,
            statsAt: now,
          }
        : {};
      return prisma.container.upsert({
        where: {
          serverId_dockerId: { serverId: server.id, dockerId: c.dockerId },
        },
        update: {
          name: c.name,
          image: c.image,
          imageDigest: c.imageDigest ?? null,
          status: c.status,
          ports: JSON.stringify(c.ports),
          composeProject: c.composeProject ?? null,
          composeService: c.composeService ?? null,
          ...statsFields,
        },
        create: {
          serverId: server.id,
          dockerId: c.dockerId,
          name: c.name,
          image: c.image,
          imageDigest: c.imageDigest ?? null,
          status: c.status,
          ports: JSON.stringify(c.ports),
          composeProject: c.composeProject ?? null,
          composeService: c.composeService ?? null,
          ...statsFields,
        },
      });
    }),
    prisma.container.deleteMany({
      where: {
        serverId: server.id,
        dockerId: { notIn: Array.from(incomingIds) },
      },
    }),
  ]);

  return NextResponse.json({ ok: true, count: containers.length });
}
