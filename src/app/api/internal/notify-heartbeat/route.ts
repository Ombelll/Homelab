import { NextResponse } from "next/server";
import { sendHeartbeat } from "@/lib/notifications";
import { checkSweepKey } from "@/lib/sweep-auth";

export const dynamic = "force-dynamic";

/**
 * Alerting-path self-test. Sends a low-priority heartbeat to every enabled
 * notification channel and returns 200 only if at least one delivered.
 *
 * Drive it from cron and gate the healthchecks.io ping on success, so a
 * silently-broken alerting path is itself caught (via the dead-man's email):
 *   0 9 * * 1  curl -fsS --max-time 30 -H "x-sweep-key: $SWEEP_KEY" \
 *       -X POST http://192.168.1.21:3000/api/internal/notify-heartbeat \
 *       && curl -fsS "$HEARTBEAT_HC_URL"
 *
 * (If the POST 500s — nothing delivered — the `&&` short-circuits, the HC ping
 * is skipped, and healthchecks.io alerts you by email.)
 */
export async function POST(request: Request) {
  const denied = checkSweepKey(request);
  if (denied) return denied;

  const r = await sendHeartbeat();
  const ok = r.total > 0 && r.sent > 0;
  return NextResponse.json({ ok, ...r }, { status: ok ? 200 : 500 });
}
