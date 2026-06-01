import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { diskSyncSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await verifyAgentKey(request))) return unauthorized();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = diskSyncSchema.safeParse(json);
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

  const incoming = new Set(parsed.data.disks.map((d) => d.mountpoint));

  await prisma.$transaction([
    ...parsed.data.disks.map((d) =>
      prisma.disk.upsert({
        where: { serverId_mountpoint: { serverId: server.id, mountpoint: d.mountpoint } },
        update: {
          fstype: d.fstype ?? null,
          totalBytes: d.totalBytes,
          usedBytes: d.usedBytes,
        },
        create: {
          serverId: server.id,
          mountpoint: d.mountpoint,
          fstype: d.fstype ?? null,
          totalBytes: d.totalBytes,
          usedBytes: d.usedBytes,
        },
      }),
    ),
    // Remove disks that disappeared (e.g. an unmounted USB drive).
    prisma.disk.deleteMany({
      where: { serverId: server.id, mountpoint: { notIn: Array.from(incoming) } },
    }),
  ]);

  return NextResponse.json({ ok: true, count: parsed.data.disks.length });
}
