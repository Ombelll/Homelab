import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { OFFLINE_AFTER_MS } from "@/lib/staleness";

export const dynamic = "force-dynamic";

/**
 * Maintenance sweep: marks servers offline when they haven't checked in
 * recently, opens / closes "agent-missing" alerts to match.
 *
 * Intended to be called periodically by an external scheduler:
 *   curl -X POST -H "x-sweep-key: $SWEEP_KEY" http://dashboard/api/internal/sweep
 *
 * Auth: SWEEP_KEY env var. If unset, the route is open (acceptable for a
 * VPN-only deployment, but set it if the dashboard is reachable elsewhere).
 */
export async function POST(request: Request) {
  const expected = process.env.SWEEP_KEY;
  if (expected && expected.length > 0) {
    const provided = request.headers.get("x-sweep-key");
    if (provided !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);
  const servers = await prisma.server.findMany();

  let markedOffline = 0;
  let cleared = 0;
  let opened = 0;

  for (const s of servers) {
    const stale = !s.lastSeenAt || s.lastSeenAt < cutoff;

    if (stale && s.status !== "offline") {
      await prisma.server.update({
        where: { id: s.id },
        data: { status: "offline" },
      });
      markedOffline++;
    }

    const existing = await prisma.alert.findFirst({
      where: { serverId: s.id, type: "agent-missing", resolved: false },
    });

    if (stale && !existing) {
      const minutes = s.lastSeenAt
        ? Math.round((Date.now() - s.lastSeenAt.getTime()) / 60000)
        : null;
      await prisma.alert.create({
        data: {
          serverId: s.id,
          type: "agent-missing",
          severity: "critical",
          message: minutes
            ? `${s.name} has not checked in for ${minutes} minutes`
            : `${s.name} has never checked in`,
        },
      });
      opened++;
    } else if (!stale && existing) {
      await prisma.alert.update({
        where: { id: existing.id },
        data: { resolved: true },
      });
      cleared++;
    }
  }

  return NextResponse.json({
    ok: true,
    inspected: servers.length,
    markedOffline,
    alertsOpened: opened,
    alertsCleared: cleared,
  });
}
