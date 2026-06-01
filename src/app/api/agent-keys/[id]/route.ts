import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const existing = await prisma.agentKey.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.agentKey.update({
    where: { id: params.id },
    data: { revokedAt: new Date() },
  });

  void recordAudit({
    user: guard.user,
    action: "agent-key.revoke",
    target: `agent-key:${existing.id}`,
    metadata: { label: existing.label, hostname: existing.hostname },
  });

  return NextResponse.json({ ok: true });
}
