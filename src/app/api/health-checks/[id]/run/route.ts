import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";
import { runProbe, type CheckType } from "@/lib/health-checks";

export const dynamic = "force-dynamic";

// One-shot probe of a single check. Updates lastStatus/lastLatencyMs so the
// row reflects the manual run, but does NOT toggle alerts — the cron sweep
// owns that lifecycle.
//
// Admin-only: a manual probe makes the dashboard host issue an outbound
// request to an operator-defined target (an SSRF lever), and every other
// health-check mutation is already admin-gated — viewers shouldn't trigger it.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const check = await prisma.healthCheck.findUnique({ where: { id: params.id } });
  if (!check) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await runProbe({
    type: check.type as CheckType,
    target: check.target,
    timeoutMs: check.timeoutMs,
    expectedStatus: check.expectedStatus,
  });

  await prisma.healthCheck.update({
    where: { id: check.id },
    data: {
      lastStatus: result.ok ? "up" : "down",
      lastCheckedAt: new Date(),
      lastLatencyMs: result.latencyMs ?? null,
      lastError: result.ok ? null : result.error,
    },
  });

  return NextResponse.json(result);
}
