import { prisma } from "@/lib/prisma";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Snapshot current per-mount and per-pool usage into CapacitySample, one row
 * per (server, kind, name, hour). Idempotent within an hour (upsert), so it's
 * safe to call from the every-15-min downsample cron. This builds the history
 * the forecast needs — there's nothing to project from until a few of these
 * have accumulated.
 */
export async function snapshotCapacity(): Promise<{ samples: number }> {
  const now = Date.now();
  const hourStart = new Date(now - (now % HOUR_MS));

  const [disks, pools] = await Promise.all([
    prisma.disk.findMany({ select: { serverId: true, mountpoint: true, usedBytes: true, totalBytes: true } }),
    prisma.zfsPool.findMany({ select: { serverId: true, name: true, usedBytes: true, totalBytes: true } }),
  ]);

  const rows = [
    ...disks.map((d) => ({ serverId: d.serverId, kind: "disk", name: d.mountpoint, usedBytes: d.usedBytes, totalBytes: d.totalBytes })),
    ...pools.map((p) => ({ serverId: p.serverId, kind: "zfs", name: p.name, usedBytes: p.usedBytes, totalBytes: p.totalBytes })),
  ].filter((r) => r.totalBytes > 0);

  let samples = 0;
  for (const r of rows) {
    await prisma.capacitySample.upsert({
      where: { serverId_kind_name_hourStart: { serverId: r.serverId, kind: r.kind, name: r.name, hourStart } },
      update: { usedBytes: r.usedBytes, totalBytes: r.totalBytes },
      create: { ...r, hourStart },
    });
    samples++;
  }
  return { samples };
}

export type Forecast = {
  /** Days until the resource hits 100% at the current growth rate. */
  etaDays: number;
  /** Growth in bytes/day (positive = filling up). */
  bytesPerDay: number;
  usedBytes: number;
  totalBytes: number;
};

/**
 * Least-squares fit of usedBytes over time. Returns a forecast only when the
 * trend is meaningfully upward and there's enough spread to trust it; null
 * otherwise (flat/shrinking usage, too few points, or a too-short window).
 */
export function forecastFull(
  samples: Array<{ usedBytes: number; totalBytes: number; hourStart: Date }>,
): Forecast | null {
  if (samples.length < 4) return null;

  const pts = samples.map((s) => ({ t: s.hourStart.getTime(), y: s.usedBytes }));
  const spanMs = pts[pts.length - 1].t - pts[0].t;
  if (spanMs < 6 * HOUR_MS) return null; // need at least a few hours of spread

  const n = pts.length;
  const meanT = pts.reduce((a, p) => a + p.t, 0) / n;
  const meanY = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - meanT) * (p.y - meanY);
    den += (p.t - meanT) ** 2;
  }
  if (den === 0) return null;
  const slopePerMs = num / den; // bytes per ms
  const bytesPerDay = slopePerMs * 86_400_000;

  const latest = samples[samples.length - 1];
  const remaining = latest.totalBytes - latest.usedBytes;
  // Need real growth and headroom left. Ignore noise below ~1 MiB/day.
  if (bytesPerDay <= 1_048_576 || remaining <= 0) return null;

  const etaDays = remaining / bytesPerDay;
  if (!Number.isFinite(etaDays) || etaDays <= 0) return null;

  return {
    etaDays: Math.round(etaDays * 10) / 10,
    bytesPerDay,
    usedBytes: latest.usedBytes,
    totalBytes: latest.totalBytes,
  };
}

/**
 * Forecast every disk + pool on a server from its recent samples. Returns a map
 * keyed by `${kind}:${name}` with a Forecast for resources that are trending
 * full. Looks back `windowDays` (default 21).
 */
export async function forecastServer(
  serverId: string,
  windowDays = 21,
): Promise<Map<string, Forecast>> {
  const since = new Date(Date.now() - windowDays * 24 * HOUR_MS);
  const samples = await prisma.capacitySample.findMany({
    where: { serverId, hourStart: { gte: since } },
    orderBy: { hourStart: "asc" },
    select: { kind: true, name: true, usedBytes: true, totalBytes: true, hourStart: true },
  });

  const byKey = new Map<string, Array<{ usedBytes: number; totalBytes: number; hourStart: Date }>>();
  for (const s of samples) {
    const key = `${s.kind}:${s.name}`;
    const arr = byKey.get(key) ?? [];
    arr.push({ usedBytes: s.usedBytes, totalBytes: s.totalBytes, hourStart: s.hourStart });
    byKey.set(key, arr);
  }

  const out = new Map<string, Forecast>();
  for (const [key, arr] of byKey) {
    const f = forecastFull(arr);
    if (f) out.set(key, f);
  }
  return out;
}
