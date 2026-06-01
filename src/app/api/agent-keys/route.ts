import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  label: z.string().min(1).max(64),
});

export async function GET() {
  const keys = await prisma.agentKey.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  return NextResponse.json({ keys });
}

export async function POST(request: Request) {
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
    data: { label: parsed.data.label, keyHash },
    select: { id: true, label: true, createdAt: true },
  });

  // IMPORTANT: plaintext is returned exactly once, here. We never store it.
  return NextResponse.json({
    ...record,
    key: plaintext,
    notice: "Save this key now. It will not be shown again.",
  });
}
