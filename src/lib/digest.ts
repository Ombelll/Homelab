import { prisma } from "@/lib/prisma";
import { sendToChannel, type ChannelType, type AlertNotification } from "@/lib/notifications";

/**
 * Build a plain-text homelab health summary: server states, open alerts,
 * backup freshness, UPS, and switch port errors. Used by the digest job.
 */
export async function buildDigest(): Promise<string> {
  const now = new Date();
  const [servers, openAlerts, ports] = await Promise.all([
    prisma.server.findMany({
      select: {
        name: true,
        status: true,
        backupAgeHours: true,
        upsStatus: true,
        upsBatteryPercent: true,
        lastSeenAt: true,
      },
    }),
    prisma.alert.findMany({
      where: { resolved: false },
      orderBy: { createdAt: "desc" },
      select: { severity: true, message: true, serverId: true },
    }),
    prisma.networkPort.findMany({
      where: { errDelta: { gt: 0 } },
      select: { name: true },
    }),
  ]);

  const byStatus = (s: string) => servers.filter((x) => x.status === s).length;
  const crit = openAlerts.filter((a) => a.severity === "critical");
  const warn = openAlerts.filter((a) => a.severity === "warning");

  const lines: string[] = [];
  lines.push(
    `Servers: ${byStatus("online")} online, ${byStatus("warning")} warning, ${
      byStatus("critical") + byStatus("offline")
    } critical/offline (of ${servers.length}).`,
  );

  const offline = servers.filter((s) => s.status === "offline" || s.status === "critical");
  if (offline.length) lines.push(`  ⚠ ${offline.map((s) => `${s.name} (${s.status})`).join(", ")}`);

  lines.push(`Open alerts: ${crit.length} critical, ${warn.length} warning.`);
  for (const a of crit.slice(0, 8)) lines.push(`  ✖ ${a.message}`);

  // Backup freshness (only hosts that report it).
  const withBackup = servers.filter((s) => s.backupAgeHours != null);
  if (withBackup.length) {
    const newest = Math.min(...withBackup.map((s) => s.backupAgeHours as number));
    lines.push(`Newest local backup: ${newest.toFixed(1)}h old.`);
  }

  // UPS.
  const ups = servers.find((s) => s.upsStatus);
  if (ups) {
    lines.push(
      `UPS: ${ups.upsStatus}${ups.upsBatteryPercent != null ? ` · ${ups.upsBatteryPercent}% battery` : ""}.`,
    );
  }

  // Switch port errors.
  if (ports.length) lines.push(`Switch: ${ports.length} port(s) with recent errors.`);

  lines.push("", `— Homelab Control Center digest · ${now.toISOString().slice(0, 16).replace("T", " ")}`);
  return lines.join("\n");
}

/**
 * Send a digest to every enabled channel, regardless of its minSeverity
 * (a digest is a deliberate summary, not an alert). Failures are swallowed
 * per channel.
 */
export async function sendDigest(): Promise<{ sent: number }> {
  const text = await buildDigest();
  const channels = await prisma.notificationChannel.findMany({ where: { enabled: true } });
  const note: AlertNotification = {
    type: "digest",
    severity: "info",
    message: text,
    serverName: "Homelab digest",
    createdAt: new Date(),
  };
  let sent = 0;
  await Promise.all(
    channels.map(async (c) => {
      try {
        await sendToChannel(c.type as ChannelType, JSON.parse(c.config || "{}"), note);
        sent++;
      } catch (err) {
        console.warn(`[digest] channel ${c.name} failed: ${(err as Error).message}`);
      }
    }),
  );
  return { sent };
}
