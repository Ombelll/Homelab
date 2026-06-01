import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  target: z.string().min(1).max(512).optional(),
  intervalSeconds: z.coerce.number().int().min(10).max(86400).optional(),
  timeoutMs: z.coerce.number().int().min(100).max(60000).optional(),
  expectedStatus: z.coerce.number().int().min(100).max(599).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const existing = await prisma.healthCheck.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

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

  await prisma.healthCheck.update({ where: { id: params.id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const existing = await prisma.healthCheck.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.healthCheck.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
