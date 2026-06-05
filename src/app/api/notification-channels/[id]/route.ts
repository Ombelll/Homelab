import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";
import { validateChannelConfig, type ChannelType } from "@/lib/notifications";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  minSeverity: z.enum(["info", "warning", "critical"]).optional(),
  alertTypes: z.string().max(512).nullable().optional(),
  config: z.unknown().optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const existing = await prisma.notificationChannel.findUnique({ where: { id: params.id } });
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

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
  if (parsed.data.minSeverity !== undefined) data.minSeverity = parsed.data.minSeverity;
  if (parsed.data.alertTypes !== undefined) data.alertTypes = parsed.data.alertTypes?.trim() || null;
  if (parsed.data.config !== undefined) {
    const check = validateChannelConfig(existing.type as ChannelType, parsed.data.config);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    data.config = JSON.stringify(check.value);
  }

  await prisma.notificationChannel.update({ where: { id: params.id }, data });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const existing = await prisma.notificationChannel.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.notificationChannel.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
