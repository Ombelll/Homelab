import { NextResponse } from "next/server";
import { sendDigest } from "@/lib/digest";
import { checkSweepKey } from "@/lib/sweep-auth";

export const dynamic = "force-dynamic";

/**
 * Send a homelab health-summary digest to all enabled notification channels.
 * Opt-in via cron (daily or weekly), e.g.:
 *
 *   0 8 * * *  curl -fsS -X POST http://dashboard/api/internal/digest \
 *                -H "x-sweep-key: $SWEEP_KEY" > /dev/null
 *
 * Shares SWEEP_KEY with the other /api/internal/* endpoints.
 */
export async function POST(request: Request) {
  const denied = checkSweepKey(request);
  if (denied) return denied;

  const result = await sendDigest();
  return NextResponse.json({ ok: true, ...result });
}
