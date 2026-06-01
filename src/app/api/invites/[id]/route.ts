import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const existing = await prisma.invite.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Hard delete: there's no audit value in keeping a revoked invite — the
  // creator's identity isn't material to the existing User records that
  // came out of it.
  await prisma.invite.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
