import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireUser } from "@/lib/authz";

export const dynamic = "force-dynamic";

const TYPES = ["http", "tcp", "ping"] as const;

const createSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(TYPES),
  target: z.string().min(1).max(512),
  intervalSeconds: z.coerce.number().int().min(10).max(86400).default(60),
  timeoutMs: z.coerce.number().int().min(100).max(60000).default(5000),
  expectedStatus: z.coerce.number().int().min(100).max(599).nullable().optional(),
  enabled: z.boolean().default(true),
});

export async function GET() {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const checks = await prisma.healthCheck.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ checks });
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

  const created = await prisma.healthCheck.create({
    data: {
      name: parsed.data.name,
      type: parsed.data.type,
      target: parsed.data.target,
      intervalSeconds: parsed.data.intervalSeconds,
      timeoutMs: parsed.data.timeoutMs,
      expectedStatus: parsed.data.expectedStatus ?? null,
      enabled: parsed.data.enabled,
    },
  });
  return NextResponse.json({ id: created.id });
}
