import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * Guard for the internal/* maintenance routes (sweep, retention, downsample,
 * run-health-checks, check-image-updates). These are meant to be triggered by
 * an external scheduler with the shared SWEEP_KEY.
 *
 * Returns a 401 Response when the x-sweep-key header doesn't match, or null
 * to proceed. If SWEEP_KEY is unset the routes stay open — acceptable for a
 * VPN-only deployment, but set it once the dashboard is reachable elsewhere.
 *
 * The comparison is constant-time so a network attacker can't recover the key
 * byte-by-byte via response timing (the agent-key path already does this; the
 * inline `!==` checks these routes used did not).
 */
export function checkSweepKey(request: Request): NextResponse | null {
  const expected = process.env.SWEEP_KEY;
  if (!expected || expected.length === 0) return null;

  const provided = request.headers.get("x-sweep-key") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return null;

  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
