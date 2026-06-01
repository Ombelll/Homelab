import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/authz";

export const dynamic = "force-dynamic";

const schema = z.object({
  minutes: z.number().int().min(0).max(7 * 24 * 60), // up to 7 days
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  let json: unknown = {};
  try {
    json = await request.json();
  } catch {
    /* allow empty / no body — minutes will fail validation */
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "minutes required" }, { status: 400 });
  }

  const alert = await prisma.alert.findUnique({ where: { id: params.id } });
  if (!alert) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Passing 0 clears the snooze; anything > 0 sets a future timestamp.
  const snoozedUntil =
    parsed.data.minutes === 0
      ? null
      : new Date(Date.now() + parsed.data.minutes * 60 * 1000);

  await prisma.alert.update({
    where: { id: alert.id },
    data: { snoozedUntil },
  });

  return NextResponse.json({ ok: true, snoozedUntil });
}
