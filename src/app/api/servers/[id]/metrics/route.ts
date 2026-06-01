import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Range catalogue: short ranges hit the raw Metric table for resolution;
// long ranges hit the hourly rollup so we don't ship 100k points.
const RANGES: Record<string, { minutes: number; source: "raw" | "hourly" }> = {
  "15m": { minutes: 15, source: "raw" },
  "1h": { minutes: 60, source: "raw" },
  "6h": { minutes: 360, source: "raw" },
  "24h": { minutes: 1440, source: "hourly" },
  "7d": { minutes: 7 * 1440, source: "hourly" },
  "30d": { minutes: 30 * 1440, source: "hourly" },
};

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const url = new URL(request.url);
  const rangeKey = url.searchParams.get("range") ?? "1h";
  const range = RANGES[rangeKey] ?? RANGES["1h"];
  const since = new Date(Date.now() - range.minutes * 60 * 1000);

  if (range.source === "raw") {
    const metrics = await prisma.metric.findMany({
      where: { serverId: params.id, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true,
        cpuPercent: true,
        memoryPercent: true,
        diskPercent: true,
      },
    });
    return NextResponse.json({
      range: rangeKey,
      source: "raw",
      since,
      count: metrics.length,
      metrics: metrics.map((m) => ({
        at: m.createdAt,
        cpu: m.cpuPercent,
        memory: m.memoryPercent,
        disk: m.diskPercent,
      })),
    });
  }

  const rows = await prisma.metricHourly.findMany({
    where: { serverId: params.id, hourStart: { gte: since } },
    orderBy: { hourStart: "asc" },
  });
  return NextResponse.json({
    range: rangeKey,
    source: "hourly",
    since,
    count: rows.length,
    metrics: rows.map((r) => ({
      at: r.hourStart,
      cpu: r.cpuAvg,
      cpuMax: r.cpuMax,
      memory: r.memoryAvg,
      memoryMax: r.memoryMax,
      disk: r.diskAvg,
      diskMax: r.diskMax,
      sampleCount: r.sampleCount,
    })),
  });
}
