import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { zfsSyncSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Upsert all ZFS pools the agent reports and delete any that disappeared
 * since last tick (e.g. a pool that was exported). Mirror of the disks
 * and sensors endpoints — same diff pattern so the dashboard's view is
 * always exactly what the host currently has.
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = zfsSyncSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!(await verifyAgentKey(request, { hostname: parsed.data.hostname }))) {
    return unauthorized();
  }

  const server = await prisma.server.findUnique({ where: { hostname: parsed.data.hostname } });
  if (!server) return NextResponse.json({ error: "unknown server" }, { status: 404 });

  const incoming = new Set(parsed.data.pools.map((p) => p.name));

  await prisma.$transaction([
    ...parsed.data.pools.map((pool) =>
      prisma.zfsPool.upsert({
        where: { serverId_name: { serverId: server.id, name: pool.name } },
        update: {
          health: pool.health,
          totalBytes: pool.totalBytes,
          usedBytes: pool.usedBytes,
          lastScrubAt: pool.lastScrubAt ? new Date(pool.lastScrubAt) : null,
        },
        create: {
          serverId: server.id,
          name: pool.name,
          health: pool.health,
          totalBytes: pool.totalBytes,
          usedBytes: pool.usedBytes,
          lastScrubAt: pool.lastScrubAt ? new Date(pool.lastScrubAt) : null,
        },
      }),
    ),
    prisma.zfsPool.deleteMany({
      where: { serverId: server.id, name: { notIn: Array.from(incoming) } },
    }),
  ]);

  return NextResponse.json({ ok: true, count: parsed.data.pools.length });
}
