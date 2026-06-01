import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const existing = await prisma.invite.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Hard delete: there's no audit value in keeping a revoked invite — the
  // creator's identity isn't material to the existing User records that
  // came out of it.
  await prisma.invite.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
