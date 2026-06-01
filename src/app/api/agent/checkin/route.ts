import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { checkinSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// Agents call this once on startup and (optionally) periodically to register
// themselves and refresh metadata like OS / IP. Metrics are sent separately.
export async function POST(request: Request) {
  if (!(await verifyAgentKey(request))) return unauthorized();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = checkinSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { hostname, name, ipAddress, os, status } = parsed.data;

  const server = await prisma.server.upsert({
    where: { hostname },
    update: {
      ...(name && { name }),
      ...(ipAddress && { ipAddress }),
      ...(os && { os }),
      status: status ?? "online",
      lastSeenAt: new Date(),
    },
    create: {
      hostname,
      name: name ?? hostname,
      ipAddress,
      os,
      status: status ?? "online",
      lastSeenAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true, serverId: server.id });
}
