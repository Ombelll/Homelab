import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  role: z.enum(["admin", "viewer"]).optional(),
  name: z.string().max(255).optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const target = await prisma.user.findUnique({ where: { id: params.id } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Refuse to leave the system without any admins.
  if (parsed.data.role === "viewer" && target.role === "admin") {
    const remainingAdmins = await prisma.user.count({
      where: { role: "admin", NOT: { id: target.id } },
    });
    if (remainingAdmins === 0) {
      return NextResponse.json(
        { error: "cannot demote the last admin" },
        { status: 400 },
      );
    }
  }

  await prisma.user.update({
    where: { id: params.id },
    data: {
      ...(parsed.data.role !== undefined && { role: parsed.data.role }),
      ...(parsed.data.name !== undefined && { name: parsed.data.name || null }),
    },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const target = await prisma.user.findUnique({ where: { id: params.id } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (target.id === guard.user.id) {
    return NextResponse.json({ error: "you cannot delete yourself" }, { status: 400 });
  }
  if (target.role === "admin") {
    const remainingAdmins = await prisma.user.count({
      where: { role: "admin", NOT: { id: target.id } },
    });
    if (remainingAdmins === 0) {
      return NextResponse.json(
        { error: "cannot delete the last admin" },
        { status: 400 },
      );
    }
  }

  // Sessions are cascade-deleted via FK, which immediately logs the user out.
  await prisma.user.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
