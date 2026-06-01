import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireAdmin, requireUser } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  label: z.string().min(1).max(64),
  // Optional hostname binding. When set, the key only authenticates
  // requests whose body specifies this exact hostname (case-insensitive
  // compare). Use this for per-host keys.
  hostname: z.string().max(255).optional().nullable(),
});

export async function GET() {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;
  const keys = await prisma.agentKey.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      hostname: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  return NextResponse.json({ keys });
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

  // 32 random bytes → 64 hex chars. Plenty of entropy for an auth secret.
  const plaintext = randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(plaintext).digest("hex");

  const record = await prisma.agentKey.create({
    data: {
      label: parsed.data.label,
      keyHash,
      hostname: parsed.data.hostname?.trim() || null,
    },
    select: { id: true, label: true, hostname: true, createdAt: true },
  });

  void recordAudit({
    user: guard.user,
    action: "agent-key.create",
    target: `agent-key:${record.id}`,
    metadata: { label: record.label, hostname: record.hostname },
  });

  // IMPORTANT: plaintext is returned exactly once, here. We never store it.
  return NextResponse.json({
    ...record,
    key: plaintext,
    notice: "Save this key now. It will not be shown again.",
  });
}
