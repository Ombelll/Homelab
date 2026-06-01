import { prisma } from "@/lib/prisma";
import { notifyAlert } from "@/lib/notifications";

/**
 * Threshold-based alert engine with sustain + ack + maintenance windows.
 *
 * Sustained breach to open: only create a new alert when the most recent N
 * metric samples (including the one we just wrote) are all over the warning
 * threshold. This avoids flapping on transient spikes (a backup kicking
 * off, `apt update` running, etc.). Resolution still requires only one
 * sample below the threshold — natural hysteresis.
 *
 * Maintenance windows: if any active MaintenanceWindow covers `now` for this
 * server (or globally with serverId=NULL), we skip alert creation entirely.
 * Already-open alerts are not closed by entering a window; they just stop
 * receiving notifications for severity upgrades.
 *
 * Ack: if the open alert has been acknowledged, suppress severity-upgrade
 * notifications. The visual severity still upgrades on the dashboard.
 *
 * Snooze: per-alert quiet time. If snoozedUntil > now, no notifications
 * fire for changes on that alert until the snooze expires.
 */

const SUSTAINED_SAMPLES = 3;

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

const METRIC_FIELD: Record<AlertType, "cpuPercent" | "memoryPercent" | "diskPercent"> = {
  "cpu-high": "cpuPercent",
  "memory-high": "memoryPercent",
  "disk-high": "diskPercent",
};

export async function evaluateMetricAlerts(input: {
  serverId: string;
  serverName: string;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
}): Promise<void> {
  const inMaintenance = await isInMaintenance(input.serverId);

  await Promise.all(
    (Object.keys(THRESHOLDS) as AlertType[]).map((type) =>
      reconcile({
        serverId: input.serverId,
        serverName: input.serverName,
        type,
        currentValue: input[METRIC_FIELD[type]],
        inMaintenance,
      }),
    ),
  );
}

async function reconcile(input: {
  serverId: string;
  serverName: string;
  type: AlertType;
  currentValue: number;
  inMaintenance: boolean;
}) {
  const { warning, critical } = THRESHOLDS[input.type];

  const open = await prisma.alert.findFirst({
    where: { serverId: input.serverId, type: input.type, resolved: false },
    orderBy: { createdAt: "desc" },
  });

  // Recovery: a single below-warning sample resolves the alert.
  if (input.currentValue < warning) {
    if (open) {
      await prisma.alert.update({ where: { id: open.id }, data: { resolved: true } });
    }
    return;
  }

  // Suppress new alerts during a maintenance window. We still upgrade
  // severity in place on an existing alert (so the UI reflects reality)
  // but we don't fire notifications for it.
  const severity = input.currentValue >= critical ? "critical" : "warning";

  if (!open) {
    if (input.inMaintenance) return;

    // Require N consecutive samples over warning to open. This includes the
    // metric we just wrote — so for SUSTAINED_SAMPLES=3 we want at least 3
    // samples and all of them above the warning threshold.
    const recent = await prisma.metric.findMany({
      where: { serverId: input.serverId },
      orderBy: { createdAt: "desc" },
      take: SUSTAINED_SAMPLES,
      select: { [METRIC_FIELD[input.type]]: true } as const,
    });
    if (recent.length < SUSTAINED_SAMPLES) return;
    const allBreaching = recent.every(
      (m) => (m as Record<string, number>)[METRIC_FIELD[input.type]] >= warning,
    );
    if (!allBreaching) return;

    const message = formatMessage(input, severity, severity === "critical" ? critical : warning);
    const created = await prisma.alert.create({
      data: { serverId: input.serverId, type: input.type, severity, message },
    });
    void notifyAlert({
      type: created.type,
      severity: created.severity,
      message: created.message,
      serverName: input.serverName,
      createdAt: created.createdAt,
    });
    return;
  }

  // Severity upgrade in place.
  if (open.severity !== "critical" && severity === "critical") {
    const upgraded = await prisma.alert.update({
      where: { id: open.id },
      data: {
        severity,
        message: formatMessage(input, severity, critical),
      },
    });

    const acked = upgraded.acknowledgedAt !== null;
    const snoozed = upgraded.snoozedUntil && upgraded.snoozedUntil > new Date();
    if (!input.inMaintenance && !acked && !snoozed) {
      void notifyAlert({
        type: upgraded.type,
        severity: upgraded.severity,
        message: upgraded.message,
        serverName: input.serverName,
        createdAt: upgraded.createdAt,
      });
    }
  }
}

function formatMessage(
  input: { serverName: string; type: AlertType; currentValue: number },
  severity: string,
  threshold: number,
): string {
  return `${HUMAN_LABEL[input.type]} usage on ${input.serverName} is ${input.currentValue.toFixed(
    1,
  )}% (threshold ${threshold}%, ${severity})`;
}

async function isInMaintenance(serverId: string): Promise<boolean> {
  const now = new Date();
  const hit = await prisma.maintenanceWindow.findFirst({
    where: {
      startsAt: { lte: now },
      endsAt: { gt: now },
      OR: [{ serverId }, { serverId: null }],
    },
    select: { id: true },
  });
  return Boolean(hit);
}
