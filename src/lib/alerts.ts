import { prisma } from "@/lib/prisma";
import { notifyAlert } from "@/lib/notifications";

/**
 * Threshold-based alert engine.
 *
 * Called from the metrics ingest path. For each resource we compare the
 * current value against a (warning, critical) pair. State machine per
 * (serverId, type):
 *
 *   value < warning  → if an open alert exists, resolve it
 *   value ≥ warning  → if no open alert exists, create one at the right
 *                      severity. If an open alert exists at a lower
 *                      severity than the current breach, upgrade it.
 *
 * No cooldown logic yet — we rely on the "one open alert per (server,type)"
 * invariant to avoid spam. Recovery requires the value to drop below the
 * warning threshold, which gives natural hysteresis.
 */

type Thresholds = { warning: number; critical: number };

const THRESHOLDS: Record<AlertType, Thresholds> = {
  "cpu-high": { warning: 80, critical: 95 },
  "memory-high": { warning: 85, critical: 95 },
  "disk-high": { warning: 85, critical: 95 },
};

type AlertType = "cpu-high" | "memory-high" | "disk-high";

const HUMAN_LABEL: Record<AlertType, string> = {
  "cpu-high": "CPU",
  "memory-high": "Memory",
  "disk-high": "Disk",
};

export async function evaluateMetricAlerts(input: {
  serverId: string;
  serverName: string;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
}): Promise<void> {
  const samples: Array<{ type: AlertType; value: number }> = [
    { type: "cpu-high", value: input.cpuPercent },
    { type: "memory-high", value: input.memoryPercent },
    { type: "disk-high", value: input.diskPercent },
  ];

  await Promise.all(
    samples.map((s) =>
      reconcile({
        serverId: input.serverId,
        serverName: input.serverName,
        type: s.type,
        value: s.value,
      }),
    ),
  );
}

async function reconcile(input: {
  serverId: string;
  serverName: string;
  type: AlertType;
  value: number;
}) {
  const { warning, critical } = THRESHOLDS[input.type];
  const severity =
    input.value >= critical ? "critical" : input.value >= warning ? "warning" : null;

  const open = await prisma.alert.findFirst({
    where: { serverId: input.serverId, type: input.type, resolved: false },
    orderBy: { createdAt: "desc" },
  });

  if (severity === null) {
    if (open) {
      await prisma.alert.update({
        where: { id: open.id },
        data: { resolved: true },
      });
    }
    return;
  }

  const message = `${HUMAN_LABEL[input.type]} usage on ${input.serverName} is ${input.value.toFixed(
    1,
  )}% (threshold ${severity === "critical" ? critical : warning}%)`;

  if (!open) {
    const created = await prisma.alert.create({
      data: {
        serverId: input.serverId,
        type: input.type,
        severity,
        message,
      },
    });
    // Fire notifications outside the create transaction so a slow webhook
    // never delays the metrics ingest path.
    void notifyAlert({
      type: created.type,
      severity: created.severity,
      message: created.message,
      serverName: input.serverName,
      createdAt: created.createdAt,
    });
    return;
  }

  // Upgrade severity in place if the situation has worsened.
  if (open.severity !== "critical" && severity === "critical") {
    const upgraded = await prisma.alert.update({
      where: { id: open.id },
      data: { severity, message },
    });
    void notifyAlert({
      type: upgraded.type,
      severity: upgraded.severity,
      message: upgraded.message,
      serverName: input.serverName,
      createdAt: upgraded.createdAt,
    });
  }
}
