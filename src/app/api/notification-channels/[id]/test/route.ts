import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";
import { sendToChannel, type ChannelType } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const channel = await prisma.notificationChannel.findUnique({ where: { id: params.id } });
  if (!channel) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const config = JSON.parse(channel.config || "{}");
    await sendToChannel(channel.type as ChannelType, config, {
      type: "test",
      severity: "info",
      message: `Test notification from Homelab Control Center (channel: ${channel.name})`,
      serverName: null,
      createdAt: new Date(),
    });
    await prisma.notificationChannel.update({
      where: { id: channel.id },
      data: { lastUsedAt: new Date(), lastError: null },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "unknown";
    await prisma.notificationChannel
      .update({ where: { id: channel.id }, data: { lastError: message } })
      .catch(() => {});
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
