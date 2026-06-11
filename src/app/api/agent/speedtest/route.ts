import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { speedtestReportSchema } from "@/lib/validation";
import { notifyAlert } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Latency we treat as a clear problem regardless of the line's speed — a
// line-agnostic signal (a slow-link threshold would be plan-specific).
const PING_WARN_MS = 150;

/**
 * Ingest the latest speed test the agent read from speedtest-tracker. Deduped
 * by testedAt (the tracker's own run time) so repeated polls of the same result
 * are idempotent. Raises a high-latency alert; download/upload are displayed
 * but not alerted on (no per-line baseline configured).
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = speedtestReportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!(await verifyAgentKey(request))) return unauthorized();

  const d = parsed.data;
  const testedAt = new Date(d.testedAt);

  // Insert only if this test is new (unique on testedAt makes it idempotent).
  const result = await prisma.speedtestResult.upsert({
    where: { testedAt },
    update: {},
    create: {
      testedAt,
      downloadMbps: d.downloadMbps,
      uploadMbps: d.uploadMbps,
      pingMs: d.pingMs,
      server: d.server ?? null,
    },
  });

  // High-latency alert, reconciled against the newest reading.
  const open = await prisma.alert.findFirst({
    where: { resolved: false, type: "internet-latency-high", serverId: null },
  });
  if (d.pingMs >= PING_WARN_MS) {
    const message = `Internet latency high: ${d.pingMs} ms (≥ ${PING_WARN_MS} ms) on the last speed test`;
    if (!open) {
      const created = await prisma.alert.create({
        data: { serverId: null, type: "internet-latency-high", severity: "warning", message },
      });
      void notifyAlert({
        type: created.type,
        severity: created.severity,
        message: created.message,
        serverName: "internet",
        createdAt: created.createdAt,
      });
    } else if (open.message !== message) {
      await prisma.alert.update({ where: { id: open.id }, data: { message } });
    }
  } else if (open) {
    await prisma.alert.update({ where: { id: open.id }, data: { resolved: true, resolvedAt: new Date() } });
  }

  return NextResponse.json({ ok: true, id: result.id });
}
