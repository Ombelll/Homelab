import { NextResponse } from "next/server";
import { downsampleHourly } from "@/lib/downsample";

export const dynamic = "force-dynamic";

/**
 * Compute hourly aggregates for completed hours. Idempotent — safe to run
 * every minute, but every 15 minutes is plenty.
 *
 *   *\/15 * * * * curl -fsS -X POST \
 *     "http://dashboard/api/internal/downsample" \
 *     -H "x-sweep-key: $SWEEP_KEY" > /dev/null
 *
 * Pair with /api/internal/retention?days=14 so raw Metric rows are pruned
 * after the rollup has read them.
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
  const lookback = Number.parseInt(url.searchParams.get("lookbackHours") ?? "", 10);

  const result = await downsampleHourly({
    lookbackHours: Number.isFinite(lookback) ? lookback : undefined,
  });

  return NextResponse.json({ ok: true, ...result });
}
