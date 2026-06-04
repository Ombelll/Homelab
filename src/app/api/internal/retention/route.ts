import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkSweepKey } from "@/lib/sweep-auth";

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
  const denied = checkSweepKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const requested = Number.parseInt(url.searchParams.get("days") ?? "", 10);
  const days = Number.isFinite(requested) && requested > 0
    ? Math.min(MAX_DAYS, requested)
    : DEFAULT_DAYS;

  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const [metrics, checkResults, upsSamples, netSamples, logs, alerts, jobs, sessions, invites, audit] =
    await prisma.$transaction([
    prisma.metric.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.healthCheckResult.deleteMany({ where: { at: { lt: cutoff } } }),
    prisma.upsSample.deleteMany({ where: { at: { lt: cutoff } } }),
    prisma.networkDeviceSample.deleteMany({ where: { at: { lt: cutoff } } }),
    prisma.logEntry.deleteMany({ where: { at: { lt: cutoff } } }),
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
    // Audit log: rotate at the same cadence as everything else. If you need
    // a longer retention for compliance, raise `days` on this cron only.
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  return NextResponse.json({
    ok: true,
    days,
    deleted: {
      metrics: metrics.count,
      checkResults: checkResults.count,
      upsSamples: upsSamples.count,
      netSamples: netSamples.count,
      logs: logs.count,
      alerts: alerts.count,
      jobs: jobs.count,
      sessions: sessions.count,
      invites: invites.count,
      audit: audit.count,
    },
  });
}
