import { NextResponse } from "next/server";
import { downsampleHourly } from "@/lib/downsample";
import { snapshotCapacity } from "@/lib/capacity";
import { checkSweepKey } from "@/lib/sweep-auth";

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
  const denied = checkSweepKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const lookback = Number.parseInt(url.searchParams.get("lookbackHours") ?? "", 10);

  const result = await downsampleHourly({
    lookbackHours: Number.isFinite(lookback) ? lookback : undefined,
  });

  // Piggyback the capacity snapshot on the same cron — builds the per-mount /
  // per-pool history the fill-up forecast reads from.
  const capacity = await snapshotCapacity();

  return NextResponse.json({ ok: true, ...result, capacitySamples: capacity.samples });
}
