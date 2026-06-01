import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Acknowledging an alert silences future severity-upgrade notifications on
// it but does not change its open/resolved state. Any signed-in user can
// ack — alerts are everyone's problem.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const alert = await prisma.alert.findUnique({ where: { id: params.id } });
  if (!alert) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.alert.update({
    where: { id: alert.id },
    data: {
      acknowledgedAt: new Date(),
      acknowledgedByUserId: guard.user.id,
    },
  });
  void recordAudit({
    user: guard.user,
    action: "alert.ack",
    target: `alert:${alert.id}`,
    metadata: { type: alert.type, severity: alert.severity },
  });
  return NextResponse.json({ ok: true });
}
