import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { parseMac } from "@/lib/wol";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  macAddress: z.string().max(64).nullable().optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const existing = await prisma.server.findUnique({ where: { id: params.id } });
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

  // Validate MAC (if provided) before writing so we never persist garbage
  // that would make the WoL endpoint fail later.
  if (parsed.data.macAddress) {
    const cleaned = parsed.data.macAddress.trim();
    if (cleaned && !parseMac(cleaned)) {
      return NextResponse.json({ error: "invalid MAC address" }, { status: 400 });
    }
  }

  const data: { name?: string; macAddress?: string | null } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.macAddress !== undefined) {
    data.macAddress = parsed.data.macAddress?.trim() || null;
  }

  await prisma.server.update({ where: { id: params.id }, data });

  void recordAudit({
    user: guard.user,
    action: "server.update",
    target: `server:${existing.id}`,
    metadata: { changes: data },
  });

  return NextResponse.json({ ok: true });
}
