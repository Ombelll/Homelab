import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Soft-revoke: keeps the row for audit (lastUsedAt remains visible) but the
// auth path rejects any key whose record has revokedAt set.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const existing = await prisma.agentKey.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.agentKey.update({
    where: { id: params.id },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
