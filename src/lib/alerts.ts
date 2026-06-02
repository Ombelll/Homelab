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
  "swap-high": { warning: 60, critical: 90 },
};

type AlertType = "cpu-high" | "memory-high" | "disk-high" | "swap-high";

const HUMAN_LABEL: Record<AlertType, string> = {
  "cpu-high": "CPU",
  "memory-high": "Memory",
  "disk-high": "Disk",
  "swap-high": "Swap",
};

const METRIC_FIELD: Record<
  AlertType,
  "cpuPercent" | "memoryPercent" | "diskPercent" | "swapPercent"
> = {
  "cpu-high": "cpuPercent",
  "memory-high": "memoryPercent",
  "disk-high": "diskPercent",
  "swap-high": "swapPercent",
};

export async function evaluateMetricAlerts(input: {
  serverId: string;
  serverName: string;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  // Swap is optional: hosts without swap (or non-Linux agents) don't report
  // it, and we must not alert on a missing signal.
  swapPercent?: number | null;
}): Promise<void> {
  const inMaintenance = await isInMaintenance(input.serverId);

  // Only evaluate swap when the agent actually reported a value this tick.
  const types = (Object.keys(THRESHOLDS) as AlertType[]).filter(
    (t) => t !== "swap-high" || input.swapPercent != null,
  );

  await Promise.all(
    types.map((type) => {
      const currentValue =
        type === "cpu-high"
          ? input.cpuPercent
          : type === "memory-high"
            ? input.memoryPercent
            : type === "disk-high"
              ? input.diskPercent
              : (input.swapPercent ?? 0);
      return reconcile({
        serverId: input.serverId,
        serverName: input.serverName,
        type,
        currentValue,
        inMaintenance,
      });
    }),
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

// --- State-based alerts ----------------------------------------------------
//
// Unlike the metric thresholds above, these track a *condition* that's either
// true or false right now (a pool is degraded, a sensor is too hot, a unit
// failed) rather than a sustained numeric breach. One alert per (server, type);
// the message names the offending entities. A single clear reading resolves.

const TEMP_WARNING_C = 85;
const TEMP_CRITICAL_C = 95;
// Per-mount fill thresholds. The root fs is already covered by the disk-high
// metric alert, so the per-mount check skips "/" to avoid a duplicate.
const MOUNT_WARNING_PCT = 85;
const MOUNT_CRITICAL_PCT = 95;

type StateType =
  | "zfs-unhealthy"
  | "temp-high"
  | "units-failed"
  | "smart-failed"
  | "disk-mount-high";

export async function evaluateStateAlerts(input: {
  serverId: string;
  serverName: string;
}): Promise<void> {
  const inMaintenance = await isInMaintenance(input.serverId);
  const [pools, sensors, latest, smart, disks] = await Promise.all([
    prisma.zfsPool.findMany({ where: { serverId: input.serverId } }),
    prisma.sensor.findMany({ where: { serverId: input.serverId, kind: "temperature" } }),
    prisma.metric.findFirst({
      where: { serverId: input.serverId },
      orderBy: { createdAt: "desc" },
      select: { failedUnits: true },
    }),
    prisma.smartDevice.findMany({ where: { serverId: input.serverId } }),
    prisma.disk.findMany({ where: { serverId: input.serverId } }),
  ]);

  const badPools = pools.filter((p) => p.health.toUpperCase() !== "ONLINE");
  const hotSensors = sensors.filter((s) => s.value >= TEMP_WARNING_C);
  const failedUnits = latest?.failedUnits ?? 0;
  const failingDisks = smart.filter((dv) => !dv.healthy);

  // Per-mount fill, skipping "/" (covered by the disk-high metric alert).
  const mountPct = (d: { totalBytes: number; usedBytes: number }) =>
    d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0;
  const fullMounts = disks.filter((d) => d.mountpoint !== "/" && mountPct(d) >= MOUNT_WARNING_PCT);

  await Promise.all([
    reconcileState({
      ...input,
      inMaintenance,
      type: "zfs-unhealthy",
      breaching: badPools.length > 0,
      severity: "critical",
      message: `ZFS ${badPools.length === 1 ? "pool" : "pools"} unhealthy on ${
        input.serverName
      }: ${badPools.map((p) => `${p.name} (${p.health})`).join(", ")}`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "temp-high",
      breaching: hotSensors.length > 0,
      severity: hotSensors.some((s) => s.value >= TEMP_CRITICAL_C) ? "critical" : "warning",
      message: `High temperature on ${input.serverName}: ${hotSensors
        .map((s) => `${s.name} ${s.value}°${s.unit || "C"}`)
        .join(", ")}`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "units-failed",
      breaching: failedUnits > 0,
      severity: "warning",
      message: `${failedUnits} failed systemd unit${failedUnits === 1 ? "" : "s"} on ${
        input.serverName
      }`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "smart-failed",
      breaching: failingDisks.length > 0,
      severity: "critical",
      message: `SMART health failing on ${input.serverName}: ${failingDisks
        .map((dv) => dv.device)
        .join(", ")}`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "disk-mount-high",
      breaching: fullMounts.length > 0,
      severity: fullMounts.some((d) => mountPct(d) >= MOUNT_CRITICAL_PCT) ? "critical" : "warning",
      message: `Filesystem(s) filling up on ${input.serverName}: ${fullMounts
        .map((d) => `${d.mountpoint} ${mountPct(d).toFixed(0)}%`)
        .join(", ")}`,
    }),
  ]);
}

async function reconcileState(input: {
  serverId: string;
  serverName: string;
  type: StateType;
  breaching: boolean;
  severity: "warning" | "critical";
  message: string;
  inMaintenance: boolean;
}) {
  const open = await prisma.alert.findFirst({
    where: { serverId: input.serverId, type: input.type, resolved: false },
    orderBy: { createdAt: "desc" },
  });

  if (!input.breaching) {
    if (open) {
      await prisma.alert.update({ where: { id: open.id }, data: { resolved: true } });
    }
    return;
  }

  if (!open) {
    if (input.inMaintenance) return;
    const created = await prisma.alert.create({
      data: {
        serverId: input.serverId,
        type: input.type,
        severity: input.severity,
        message: input.message,
      },
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

  // Already open: refresh the message (entities may have changed) and notify
  // only on a genuine upgrade to critical, mirroring the threshold engine's
  // ack/snooze/maintenance suppression.
  const upgrade = open.severity !== "critical" && input.severity === "critical";
  const updated = await prisma.alert.update({
    where: { id: open.id },
    data: { severity: input.severity, message: input.message },
  });
  if (upgrade) {
    const acked = updated.acknowledgedAt !== null;
    const snoozed = updated.snoozedUntil && updated.snoozedUntil > new Date();
    if (!input.inMaintenance && !acked && !snoozed) {
      void notifyAlert({
        type: updated.type,
        severity: updated.severity,
        message: updated.message,
        serverName: input.serverName,
        createdAt: updated.createdAt,
      });
    }
  }
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
