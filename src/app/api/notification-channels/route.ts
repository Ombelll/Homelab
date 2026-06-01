import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireUser } from "@/lib/authz";
import {
  CHANNEL_TYPES,
  redactConfig,
  validateChannelConfig,
  type ChannelType,
} from "@/lib/notifications";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(CHANNEL_TYPES),
  enabled: z.boolean().default(true),
  minSeverity: z.enum(["info", "warning", "critical"]).default("warning"),
  config: z.unknown(),
});

export async function GET() {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const channels = await prisma.notificationChannel.findMany({
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      minSeverity: c.minSeverity,
      config: redactConfig(c.type as ChannelType, safeParse(c.config)),
      lastUsedAt: c.lastUsedAt,
      lastError: c.lastError,
      createdAt: c.createdAt,
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

  const configCheck = validateChannelConfig(parsed.data.type, parsed.data.config);
  if (!configCheck.ok) {
    return NextResponse.json({ error: configCheck.error }, { status: 400 });
  }

  const created = await prisma.notificationChannel.create({
    data: {
      name: parsed.data.name,
      type: parsed.data.type,
      enabled: parsed.data.enabled,
      minSeverity: parsed.data.minSeverity,
      config: JSON.stringify(configCheck.value),
    },
  });
  return NextResponse.json({ id: created.id });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
