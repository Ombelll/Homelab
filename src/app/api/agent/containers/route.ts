import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { containerSyncSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// Agents post the full list of Docker containers they see. We diff against
// existing rows so the dashboard reflects the live state — containers no
// longer present on the host are deleted.
export async function POST(request: Request) {
  if (!(await verifyAgentKey(request))) return unauthorized();

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

  const { hostname, containers } = parsed.data;

  const server = await prisma.server.findUnique({ where: { hostname } });
  if (!server) {
    return NextResponse.json(
      { error: "unknown server, call /api/agent/checkin first" },
      { status: 404 },
    );
  }

  const incomingIds = new Set(containers.map((c) => c.dockerId));

  await prisma.$transaction([
    ...containers.map((c) =>
      prisma.container.upsert({
        where: {
          serverId_dockerId: { serverId: server.id, dockerId: c.dockerId },
        },
        update: {
          name: c.name,
          image: c.image,
          status: c.status,
          ports: JSON.stringify(c.ports),
        },
        create: {
          serverId: server.id,
          dockerId: c.dockerId,
          name: c.name,
          image: c.image,
          status: c.status,
          ports: JSON.stringify(c.ports),
        },
      }),
    ),
    prisma.container.deleteMany({
      where: {
        serverId: server.id,
        dockerId: { notIn: Array.from(incomingIds) },
      },
    }),
  ]);

  return NextResponse.json({ ok: true, count: containers.length });
}
