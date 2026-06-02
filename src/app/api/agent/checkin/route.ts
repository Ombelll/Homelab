import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { checkinSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// Agents call this once on startup and (optionally) periodically to register
// themselves and refresh metadata like OS / IP. Metrics are sent separately.
export async function POST(request: Request) {
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

  // Verify auth after parsing so we can enforce hostname binding on
  // per-host AgentKeys.
  if (!(await verifyAgentKey(request, { hostname: parsed.data.hostname }))) {
    return unauthorized();
  }

  const { hostname, name, ipAddress, os, status, bootAt, loadAvg, rebootRequired } =
    parsed.data;

  // Look up existing server to compute rebootRequiredSince: only stamp it
  // when the flag transitions from false→true, so the dashboard can show
  // "asks for reboot since 5 days ago" instead of resetting every tick.
  const existing = await prisma.server.findUnique({ where: { hostname } });
  const reboot = rebootRequired ?? false;
  const rebootRequiredSince =
    reboot && !existing?.rebootRequired
      ? new Date()
      : reboot
        ? existing?.rebootRequiredSince ?? new Date()
        : null;

  const server = await prisma.server.upsert({
    where: { hostname },
    update: {
      ...(name && { name }),
      ...(ipAddress && { ipAddress }),
      ...(os && { os }),
      status: status ?? "online",
      lastSeenAt: new Date(),
      ...(bootAt && { bootAt: new Date(bootAt) }),
      ...(loadAvg && { loadAvg: JSON.stringify(loadAvg) }),
      rebootRequired: reboot,
      rebootRequiredSince,
    },
    create: {
      hostname,
      name: name ?? hostname,
      ipAddress,
      os,
      status: status ?? "online",
      lastSeenAt: new Date(),
      bootAt: bootAt ? new Date(bootAt) : null,
      loadAvg: loadAvg ? JSON.stringify(loadAvg) : null,
      rebootRequired: reboot,
      rebootRequiredSince,
    },
  });

  return NextResponse.json({ ok: true, serverId: server.id });
}
