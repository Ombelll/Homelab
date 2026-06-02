import { NextResponse } from "next/server";
import { runDueChecks } from "@/lib/health-checks";
import { checkSweepKey } from "@/lib/sweep-auth";

export const dynamic = "force-dynamic";

/**
 * Probe all due health checks. Same SWEEP_KEY guard as the other internal
 * routes. Recommended cadence:
 *
 *   * * * * * curl -fsS -X POST http://dashboard/api/internal/run-health-checks \
 *               -H "x-sweep-key: $SWEEP_KEY" > /dev/null
 */
export async function POST(request: Request) {
  const denied = checkSweepKey(request);
  if (denied) return denied;

  const result = await runDueChecks();
  return NextResponse.json({ ok: true, ...result });
}
