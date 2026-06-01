import { prisma } from "@/lib/prisma";

/**
 * Roll up raw Metric rows into hourly aggregates.
 *
 * Idempotent per (server, hour): re-running just overwrites the row with the
 * current aggregate, which is fine because the inputs for a completed hour
 * are immutable.
 *
 * We only roll up COMPLETED hours (strictly less than the start of the
 * current UTC hour) so the rollup for the in-flight hour isn't built from
 * a partial window — wait until the hour ends.
 */
export async function downsampleHourly(input?: {
  /** Look back at most this many hours. Default 48 — enough to catch a
   *  weekend outage of the cron job. */
  lookbackHours?: number;
}): Promise<{ rolledUp: number; hoursScanned: number; servers: number }> {
  const lookback = Math.max(1, Math.min(168, input?.lookbackHours ?? 48));

  const now = Date.now();
  const currentHourStart = new Date(now - (now % HOUR_MS));
  const windowStart = new Date(currentHourStart.getTime() - lookback * HOUR_MS);

  const servers = await prisma.server.findMany({ select: { id: true } });

  let rolledUp = 0;
  let hoursScanned = 0;

  for (const s of servers) {
    // Pull metrics for the whole window, then bucket in JS. For 5 hosts × 48h
    // × 120 samples/hour that's < 30k rows — well within SQLite reach.
    const samples = await prisma.metric.findMany({
      where: {
        serverId: s.id,
        createdAt: { gte: windowStart, lt: currentHourStart },
      },
      select: { cpuPercent: true, memoryPercent: true, diskPercent: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const buckets = new Map<number, Bucket>();
    for (const m of samples) {
      const hourStartMs = m.createdAt.getTime() - (m.createdAt.getTime() % HOUR_MS);
      let b = buckets.get(hourStartMs);
      if (!b) {
        b = { cpuSum: 0, cpuMax: 0, memSum: 0, memMax: 0, diskSum: 0, diskMax: 0, n: 0 };
        buckets.set(hourStartMs, b);
      }
      b.cpuSum += m.cpuPercent;
      b.memSum += m.memoryPercent;
      b.diskSum += m.diskPercent;
      if (m.cpuPercent > b.cpuMax) b.cpuMax = m.cpuPercent;
      if (m.memoryPercent > b.memMax) b.memMax = m.memoryPercent;
      if (m.diskPercent > b.diskMax) b.diskMax = m.diskPercent;
      b.n++;
    }

    for (const [hourStartMs, b] of buckets) {
      hoursScanned++;
      const data = {
        cpuAvg: round2(b.cpuSum / b.n),
        cpuMax: round2(b.cpuMax),
        memoryAvg: round2(b.memSum / b.n),
        memoryMax: round2(b.memMax),
        diskAvg: round2(b.diskSum / b.n),
        diskMax: round2(b.diskMax),
        sampleCount: b.n,
      };
      await prisma.metricHourly.upsert({
        where: { serverId_hourStart: { serverId: s.id, hourStart: new Date(hourStartMs) } },
        update: data,
        create: { serverId: s.id, hourStart: new Date(hourStartMs), ...data },
      });
      rolledUp++;
    }
  }

  return { rolledUp, hoursScanned, servers: servers.length };
}

const HOUR_MS = 60 * 60 * 1000;

type Bucket = {
  cpuSum: number;
  cpuMax: number;
  memSum: number;
  memMax: number;
  diskSum: number;
  diskMax: number;
  n: number;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
