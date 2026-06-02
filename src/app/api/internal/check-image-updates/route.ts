import { NextResponse } from "next/server";
import { checkContainerImageUpdates } from "@/lib/image-updates";
import { checkSweepKey } from "@/lib/sweep-auth";

export const dynamic = "force-dynamic";

/**
 * Fire from cron daily (or hourly if you want faster discovery):
 *
 *   0 4 * * * curl -fsS -X POST http://dashboard/api/internal/check-image-updates \
 *               -H "x-sweep-key: $SWEEP_KEY" > /dev/null
 *
 * The checker only re-polls each image every 6h, so it's cheap to call
 * more often than that.
 */
export async function POST(request: Request) {
  const denied = checkSweepKey(request);
  if (denied) return denied;

  const result = await checkContainerImageUpdates();
  return NextResponse.json({ ok: true, ...result });
}
