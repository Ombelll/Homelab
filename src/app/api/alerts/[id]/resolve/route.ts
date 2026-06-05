import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Manual resolve — useful when an alert was triggered by something the user
// has now fixed but the next metric tick hasn't caught up yet, or for
// 'system'-scoped alerts that the engine won't auto-resolve.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const alert = await prisma.alert.findUnique({ where: { id: params.id } });
  if (!alert) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.alert.update({
    where: { id: alert.id },
    data: { resolved: true, resolvedAt: new Date() },
  });
  void recordAudit({
    user: guard.user,
    action: "alert.resolve",
    target: `alert:${alert.id}`,
    metadata: { type: alert.type, severity: alert.severity },
  });
  return NextResponse.json({ ok: true });
}
