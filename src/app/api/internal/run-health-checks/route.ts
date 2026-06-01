import { NextResponse } from "next/server";
import { runDueChecks } from "@/lib/health-checks";

export const dynamic = "force-dynamic";

/**
 * Probe all due health checks. Same SWEEP_KEY guard as the other internal
 * routes. Recommended cadence:
 *
 *   * * * * * curl -fsS -X POST http://dashboard/api/internal/run-health-checks \
 *               -H "x-sweep-key: $SWEEP_KEY" > /dev/null
 */
export async function POST(request: Request) {
  const expected = process.env.SWEEP_KEY;
  if (expected && expected.length > 0) {
    const provided = request.headers.get("x-sweep-key");
    if (provided !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const result = await runDueChecks();
  return NextResponse.json({ ok: true, ...result });
}
