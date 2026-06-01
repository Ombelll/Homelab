import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { sendMagicPacket } from "@/lib/wol";

export const dynamic = "force-dynamic";

/**
 * Send a Wake-on-LAN magic packet to a server's MAC. Only works from the
 * dashboard host's LAN broadcast domain; for cross-subnet WoL you'll want
 * a relay on each subnet (not implemented).
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const server = await prisma.server.findUnique({ where: { id: params.id } });
  if (!server) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!server.macAddress) {
    return NextResponse.json(
      { error: "no MAC address configured for this server" },
      { status: 400 },
    );
  }

  try {
    await sendMagicPacket(server.macAddress);
  } catch (err) {
    return NextResponse.json(
      { error: `wake failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  void recordAudit({
    user: guard.user,
    action: "server.wake",
    target: `server:${server.id}`,
    metadata: { mac: server.macAddress },
  });

  return NextResponse.json({ ok: true, sent: true });
}
