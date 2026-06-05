import { prisma } from "@/lib/prisma";
import { notifyAlert } from "@/lib/notifications";
import { forecastServer } from "@/lib/capacity";

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
      await prisma.alert.update({ where: { id: open.id }, data: { resolved: true, resolvedAt: new Date() } });
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
// Backup-staleness thresholds (hours). Backups run daily, so >36h means a day
// was missed; >72h is multiple days.
const BACKUP_WARN_HOURS = 36;
const BACKUP_CRIT_HOURS = 72;

type StateType =
  | "zfs-unhealthy"
  | "temp-high"
  | "units-failed"
  | "smart-failed"
  | "disk-mount-high"
  | "backup-stale"
  | "container-unhealthy"
  | "ups-on-battery"
  | "smart-degrading"
  | "capacity-forecast"
  | "memory-leak";

// SMART degradation (early warning, before a drive flips to outright failed):
// reallocated sectors climbing, or an SSD's wear indicator running out.
const REALLOC_WARN = 10;
const REALLOC_CRIT = 50;
const WEAR_WARN = 90;
const WEAR_CRIT = 95;
// NVMe available-spare percentage: warns as it drops toward the drive's
// threshold, critical when nearly exhausted.
const SPARE_WARN = 10;
const SPARE_CRIT = 5;
// A SMART self-test result that indicates a failure (read errors, damage),
// excluding the healthy "completed without error" and in-progress states.
function selfTestFailed(status: string | null | undefined): boolean {
  if (!status) return false;
  if (/without error|in progress|never started/i.test(status)) return false;
  return /fail|error|damage|unknown failure/i.test(status);
}
// Capacity fill-up forecast: warn when a disk/pool is projected to hit 100%
// within this many days at its current growth rate; critical when very soon.
const FORECAST_WARN_DAYS = 30;
const FORECAST_CRIT_DAYS = 14;
// Memory-leak heuristic: a sustained upward trend in memory% (not a transient
// spike). Needs real climb (≥ this %/day), already-elevated usage, and a
// projected hit of ~95% within the horizon. Critical if that's imminent.
const MEM_LEAK_MIN_SLOPE_PER_DAY = 3;
const MEM_LEAK_MIN_CURRENT = 60;
const MEM_LEAK_WARN_DAYS = 14;
const MEM_LEAK_CRIT_DAYS = 3;

// Least-squares slope (%/day) of memory over time + projected days to 95%.
// Returns null when there isn't enough spread or the trend is flat/down.
function memoryLeakForecast(
  points: Array<{ memoryPercent: number; createdAt: Date }>,
): { slopePerDay: number; daysTo95: number; current: number } | null {
  if (points.length < 8) return null;
  const t0 = points[0].createdAt.getTime();
  const xs = points.map((p) => (p.createdAt.getTime() - t0) / 86_400_000); // days
  const ys = points.map((p) => p.memoryPercent);
  const spanDays = xs[xs.length - 1];
  if (spanDays < 0.5) return null; // need at least ~12h of data
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const slopePerDay = num / den;
  const current = ys[ys.length - 1];
  if (slopePerDay < MEM_LEAK_MIN_SLOPE_PER_DAY || current < MEM_LEAK_MIN_CURRENT) return null;
  const daysTo95 = (95 - current) / slopePerDay;
  if (!Number.isFinite(daysTo95) || daysTo95 <= 0) return null;
  return { slopePerDay, daysTo95, current };
}

export async function evaluateStateAlerts(input: {
  serverId: string;
  serverName: string;
}): Promise<void> {
  const inMaintenance = await isInMaintenance(input.serverId);
  const memSince = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const [pools, sensors, latest, smart, disks, server, memHistory, containers] = await Promise.all([
    prisma.zfsPool.findMany({ where: { serverId: input.serverId } }),
    prisma.sensor.findMany({ where: { serverId: input.serverId, kind: "temperature" } }),
    prisma.metric.findFirst({
      where: { serverId: input.serverId },
      orderBy: { createdAt: "desc" },
      select: { failedUnits: true },
    }),
    prisma.smartDevice.findMany({ where: { serverId: input.serverId } }),
    prisma.disk.findMany({ where: { serverId: input.serverId } }),
    prisma.server.findUnique({
      where: { id: input.serverId },
      select: {
        backupAgeHours: true,
        upsStatus: true,
        upsBatteryPercent: true,
        upsRuntimeSec: true,
      },
    }),
    prisma.metric.findMany({
      where: { serverId: input.serverId, createdAt: { gte: memSince } },
      orderBy: { createdAt: "asc" },
      select: { memoryPercent: true, createdAt: true },
    }),
    prisma.container.findMany({
      where: { serverId: input.serverId },
      select: {
        name: true,
        status: true,
        health: true,
        oomKilled: true,
        memoryBytes: true,
        memoryLimitBytes: true,
      },
    }),
  ]);

  const badPools = pools.filter((p) => p.health.toUpperCase() !== "ONLINE");
  const hotSensors = sensors.filter((s) => s.value >= TEMP_WARNING_C);
  const failedUnits = latest?.failedUnits ?? 0;
  const failingDisks = smart.filter((dv) => !dv.healthy);
  // Healthy-but-degrading drives: reallocated sectors or SSD wear over threshold.
  const degrading = smart.filter(
    (dv) =>
      dv.healthy &&
      ((dv.reallocatedSectors ?? 0) >= REALLOC_WARN ||
        (dv.wearPercent ?? 0) >= WEAR_WARN ||
        (dv.mediaErrors ?? 0) > 0 ||
        (dv.criticalWarning ?? 0) > 0 ||
        (dv.availableSparePercent != null && dv.availableSparePercent <= SPARE_WARN) ||
        selfTestFailed(dv.selfTestStatus)),
  );

  // Capacity forecast: disks/pools projected to fill within the warn horizon,
  // soonest first. Empty until enough CapacitySample history has accumulated.
  const forecasts = await forecastServer(input.serverId);
  const fillingSoon = [...forecasts.entries()]
    .filter(([, f]) => f.etaDays <= FORECAST_WARN_DAYS)
    .sort((a, b) => a[1].etaDays - b[1].etaDays);

  // Memory-leak trend over the last 48h.
  const memLeak = memoryLeakForecast(memHistory);

  // A container is "in trouble" when its healthcheck reports unhealthy or it's
  // stuck restart-looping. We deliberately do NOT alert on "exited"/"created"/
  // "paused" — those are usually intentional and would be noisy.
  // A container counts as "near its memory limit" only when a real cgroup
  // limit is set (the agent reports the configured limit; without one the
  // limit is host RAM and the ratio stays low → no false positives).
  const MEM_NEAR_LIMIT = 0.9;
  const nearLimit = (c: { memoryBytes: number | null; memoryLimitBytes: number | null }) =>
    c.memoryBytes != null &&
    c.memoryLimitBytes != null &&
    c.memoryLimitBytes > 0 &&
    c.memoryBytes / c.memoryLimitBytes >= MEM_NEAR_LIMIT;

  const badContainers = containers.filter(
    (c) => c.health === "unhealthy" || c.status === "restarting" || c.oomKilled || nearLimit(c),
  );
  const reason = (c: {
    status: string;
    health: string | null;
    oomKilled: boolean | null;
    memoryBytes: number | null;
    memoryLimitBytes: number | null;
  }) =>
    c.oomKilled
      ? "OOM-killed"
      : c.health === "unhealthy"
        ? "unhealthy"
        : c.status === "restarting"
          ? "restarting"
          : nearLimit(c)
            ? `mem ${Math.round((c.memoryBytes! / c.memoryLimitBytes!) * 100)}%`
            : "issue";

  // NUT status flags: OL=on mains, OB=on battery, LB=low battery. We alert
  // while on battery (mains outage in progress) and escalate to critical at
  // low battery (host shutdown is imminent).
  const upsTokens = (server?.upsStatus ?? "").toUpperCase().split(/\s+/).filter(Boolean);
  const upsOnBattery = upsTokens.includes("OB");
  const upsLowBattery = upsTokens.includes("LB");

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
    reconcileState({
      ...input,
      inMaintenance,
      type: "backup-stale",
      // Only hosts that report a backup age can be stale; null = no backups
      // here, so never alert.
      breaching: server?.backupAgeHours != null && server.backupAgeHours >= BACKUP_WARN_HOURS,
      severity:
        server?.backupAgeHours != null && server.backupAgeHours >= BACKUP_CRIT_HOURS
          ? "critical"
          : "warning",
      message: `Backups stale on ${input.serverName}: newest is ${
        server?.backupAgeHours ?? "?"
      }h old`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "container-unhealthy",
      breaching: badContainers.length > 0,
      severity: "warning",
      message: `Container issue${badContainers.length === 1 ? "" : "s"} on ${
        input.serverName
      }: ${badContainers.map((c) => `${c.name} (${reason(c)})`).join(", ")}`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "smart-degrading",
      breaching: degrading.length > 0,
      severity: degrading.some(
        (dv) =>
          (dv.reallocatedSectors ?? 0) >= REALLOC_CRIT ||
          (dv.wearPercent ?? 0) >= WEAR_CRIT ||
          (dv.mediaErrors ?? 0) > 0 ||
          (dv.criticalWarning ?? 0) > 0 ||
          (dv.availableSparePercent != null && dv.availableSparePercent <= SPARE_CRIT) ||
          selfTestFailed(dv.selfTestStatus),
      )
        ? "critical"
        : "warning",
      message: `SMART degrading on ${input.serverName}: ${degrading
        .map((dv) => {
          const bits: string[] = [];
          if ((dv.reallocatedSectors ?? 0) >= REALLOC_WARN) bits.push(`${dv.reallocatedSectors} reallocated`);
          if ((dv.wearPercent ?? 0) >= WEAR_WARN) bits.push(`${dv.wearPercent}% wear`);
          if ((dv.mediaErrors ?? 0) > 0) bits.push(`${dv.mediaErrors} media errors`);
          if ((dv.criticalWarning ?? 0) > 0) bits.push(`critical warning 0x${(dv.criticalWarning ?? 0).toString(16)}`);
          if (dv.availableSparePercent != null && dv.availableSparePercent <= SPARE_WARN)
            bits.push(`${dv.availableSparePercent}% spare`);
          if (selfTestFailed(dv.selfTestStatus)) bits.push(`self-test: ${dv.selfTestStatus}`);
          return `${dv.device} (${bits.join(", ")})`;
        })
        .join(", ")}`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "ups-on-battery",
      breaching: upsOnBattery || upsLowBattery,
      severity: upsLowBattery ? "critical" : "warning",
      message: `${input.serverName} is on UPS battery${
        upsLowBattery ? " — LOW BATTERY, shutdown imminent" : " (mains power lost)"
      }: ${server?.upsBatteryPercent ?? "?"}% charge${
        server?.upsRuntimeSec != null
          ? `, ~${Math.round(server.upsRuntimeSec / 60)} min runtime left`
          : ""
      }`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "capacity-forecast",
      breaching: fillingSoon.length > 0,
      severity: fillingSoon.some(([, f]) => f.etaDays <= FORECAST_CRIT_DAYS) ? "critical" : "warning",
      message: `Filling up on ${input.serverName}: ${fillingSoon
        .map(([key, f]) => `${key.replace(/^(disk|zfs):/, "")} full in ~${Math.round(f.etaDays)}d`)
        .join(", ")}`,
    }),
    reconcileState({
      ...input,
      inMaintenance,
      type: "memory-leak",
      breaching: memLeak != null && memLeak.daysTo95 <= MEM_LEAK_WARN_DAYS,
      severity: memLeak != null && memLeak.daysTo95 <= MEM_LEAK_CRIT_DAYS ? "critical" : "warning",
      message: memLeak
        ? `Memory trending up on ${input.serverName}: ${memLeak.current.toFixed(0)}% and climbing ~${memLeak.slopePerDay.toFixed(1)}%/day → ~95% in ${Math.round(memLeak.daysTo95)}d (possible leak)`
        : `Memory trend normal on ${input.serverName}`,
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
      await prisma.alert.update({ where: { id: open.id }, data: { resolved: true, resolvedAt: new Date() } });
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
