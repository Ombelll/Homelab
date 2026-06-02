import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const servers = await prisma.server.findMany({
    orderBy: { name: "asc" },
    include: {
      metrics: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { containers: true } },
    },
  });

  const result = servers.map((s) => {
    const latest = s.metrics[0];
    return {
      id: s.id,
      name: s.name,
      hostname: s.hostname,
      ipAddress: s.ipAddress,
      os: s.os,
      status: s.status,
      lastSeenAt: s.lastSeenAt,
      containerCount: s._count.containers,
      latestMetric: latest
        ? {
            cpuPercent: latest.cpuPercent,
            memoryPercent: latest.memoryPercent,
            diskPercent: latest.diskPercent,
            at: latest.createdAt,
          }
        : null,
    };
  });

  return NextResponse.json({ servers: result });
}
