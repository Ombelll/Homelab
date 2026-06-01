import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const RANGE_MINUTES: Record<string, number> = {
  "15m": 15,
  "1h": 60,
  "6h": 360,
  "24h": 1440,
};

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "1h";
  const minutes = RANGE_MINUTES[range] ?? RANGE_MINUTES["1h"];

  const since = new Date(Date.now() - minutes * 60 * 1000);

  const metrics = await prisma.metric.findMany({
    where: { serverId: params.id, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, cpuPercent: true, memoryPercent: true, diskPercent: true },
  });

  return NextResponse.json({ range, since, count: metrics.length, metrics });
}
