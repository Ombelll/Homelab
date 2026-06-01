import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;

/**
 * Prune old data so the DB doesn't grow forever.
 *
 * Time-windowed (controlled by ?days, default 14):
 *   - Metric rows
 *   - Resolved Alert rows
 *   - Done/error Job rows (LogChunks cascade with their parent Job)
 *   - Used or expired Invite rows
 *
 * Always pruned regardless of `days`:
 *   - Expired Session rows — once a session has passed its expiresAt it's
 *     not usable, and lazy cleanup only fires when the user tries to use
 *     the cookie. Pruning here keeps the table from growing unbounded.
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

  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const [metrics, alerts, jobs, sessions, invites] = await prisma.$transaction([
    prisma.metric.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.alert.deleteMany({
      where: { resolved: true, createdAt: { lt: cutoff } },
    }),
    prisma.job.deleteMany({
      where: { status: { in: ["done", "error"] }, completedAt: { lt: cutoff } },
    }),
    // Expired sessions: always purgeable, no need to wait `days`.
    prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    // Invites that have either been consumed OR are past their expiry, and
    // whose creation is older than `days` ago — keeps a short window of
    // history for audit without growing forever.
    prisma.invite.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        OR: [{ usedAt: { not: null } }, { expiresAt: { lt: now } }],
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    days,
    deleted: {
      metrics: metrics.count,
      alerts: alerts.count,
      jobs: jobs.count,
      sessions: sessions.count,
      invites: invites.count,
    },
  });
}
