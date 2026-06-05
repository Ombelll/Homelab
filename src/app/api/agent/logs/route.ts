import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { logsReportSchema } from "@/lib/validation";
import { scanLogLines } from "@/lib/log-patterns";
import { notifyAlert } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * Ingest shipped warn/error log lines from an agent (host journal + container
 * logs). Stored for after-the-fact searching on the Logs page; pruned by the
 * retention job. 404 tells the agent to re-check-in first.
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = logsReportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const d = parsed.data;
  if (!(await verifyAgentKey(request, { hostname: d.hostname }))) return unauthorized();

  const server = await prisma.server.findUnique({ where: { hostname: d.hostname } });
  if (!server) {
    return NextResponse.json({ error: "unknown server, call /api/agent/checkin first" }, { status: 404 });
  }

  if (d.lines.length === 0) return NextResponse.json({ ok: true, stored: 0 });

  await prisma.logEntry.createMany({
    data: d.lines.map((l) => ({
      serverId: server.id,
      source: l.source,
      message: l.message,
      ...(l.at ? { at: new Date(l.at) } : {}),
    })),
  });

  // Critical-pattern alerting: scan the batch for high-signal lines (OOM, I/O
  // errors, ZFS/FS corruption, crashes, thermal). One open alert per
  // server+pattern — we only create + notify when there isn't already an
  // unresolved one, so a recurring line doesn't spam.
  for (const match of scanLogLines(d.lines)) {
    const type = `log:${match.pattern.key}`;
    const open = await prisma.alert.findFirst({
      where: { serverId: server.id, type, resolved: false },
    });
    if (open) continue;
    const created = await prisma.alert.create({
      data: {
        serverId: server.id,
        type,
        severity: match.pattern.severity,
        message: `${match.pattern.label} on ${server.name}: ${match.sample.slice(0, 200)}`,
      },
    });
    void notifyAlert({
      type: created.type,
      severity: created.severity,
      message: created.message,
      serverName: server.name,
      createdAt: created.createdAt,
    });
  }

  return NextResponse.json({ ok: true, stored: d.lines.length });
}
