import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;

/**
 * Prune old data so the SQLite file doesn't grow forever.
 *
 * Currently removes:
 *   - Metric rows older than ?days (default 14)
 *   - Resolved Alert rows older than ?days
 *   - Done/error Job rows older than ?days
 *
 * Call from cron:
 *   30 3 * * *  curl -fsS -X POST http://dashboard/api/internal/retention?days=30 \
 *                 -H "x-sweep-key: $SWEEP_KEY" > /dev/null
 *
 * Shares SWEEP_KEY with /api/internal/sweep so you only manage one secret.
 */
export async function POST(request: Request) {
  const expected = process.env.SWEEP_KEY;
  if (expected && expected.length > 0) {
    const provided = request.headers.get("x-sweep-key");
    if (provided !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  const requested = Number.parseInt(url.searchParams.get("days") ?? "", 10);
  const days = Number.isFinite(requested) && requested > 0
    ? Math.min(MAX_DAYS, requested)
    : DEFAULT_DAYS;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [metrics, alerts, jobs] = await prisma.$transaction([
    prisma.metric.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.alert.deleteMany({
      where: { resolved: true, createdAt: { lt: cutoff } },
    }),
    prisma.job.deleteMany({
      where: { status: { in: ["done", "error"] }, completedAt: { lt: cutoff } },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    days,
    deleted: {
      metrics: metrics.count,
      alerts: alerts.count,
      jobs: jobs.count,
    },
  });
}
