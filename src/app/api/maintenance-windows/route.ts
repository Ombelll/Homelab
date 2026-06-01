import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  serverId: z.string().nullable().optional(),
  reason: z.string().max(255).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const windows = await prisma.maintenanceWindow.findMany({
    orderBy: { startsAt: "desc" },
    take: 50,
    include: { server: { select: { id: true, name: true, hostname: true } } },
  });
  const now = new Date();
  return NextResponse.json({
    windows: windows.map((w) => ({
      id: w.id,
      serverId: w.serverId,
      serverName: w.server?.name ?? null,
      reason: w.reason,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      active: w.startsAt <= now && w.endsAt > now,
      createdAt: w.createdAt,
    })),
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (parsed.data.endsAt <= parsed.data.startsAt) {
    return NextResponse.json({ error: "endsAt must be after startsAt" }, { status: 400 });
  }

  const created = await prisma.maintenanceWindow.create({
    data: {
      serverId: parsed.data.serverId || null,
      reason: parsed.data.reason || null,
      startsAt: parsed.data.startsAt,
      endsAt: parsed.data.endsAt,
    },
  });
  return NextResponse.json({ id: created.id });
}
