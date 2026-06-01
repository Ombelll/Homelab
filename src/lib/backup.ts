import { prisma } from "@/lib/prisma";

// Tables included in backup/restore. Sessions are deliberately excluded —
// restoring active session tokens to a different deployment would let
// someone resume with stale credentials. LogChunks and stale Jobs are
// transient and not worth restoring.
export const BACKUP_VERSION = 1;

export async function exportBackup() {
  const [
    users,
    servers,
    metrics,
    metricsHourly,
    containers,
    disks,
    sensors,
    alerts,
    maintenanceWindows,
    agentKeys,
    notificationChannels,
    invites,
    healthChecks,
    auditLog,
  ] = await Promise.all([
    prisma.user.findMany(),
    prisma.server.findMany(),
    // Cap metrics export at the most recent month to keep dumps reasonable.
    prisma.metric.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    }),
    prisma.metricHourly.findMany(),
    prisma.container.findMany(),
    prisma.disk.findMany(),
    prisma.sensor.findMany(),
    prisma.alert.findMany(),
    prisma.maintenanceWindow.findMany(),
    prisma.agentKey.findMany(),
    prisma.notificationChannel.findMany(),
    prisma.invite.findMany(),
    prisma.healthCheck.findMany(),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    }),
  ]);

  return {
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      users: users.length,
      servers: servers.length,
      metrics: metrics.length,
      metricsHourly: metricsHourly.length,
      containers: containers.length,
      disks: disks.length,
      sensors: sensors.length,
      alerts: alerts.length,
      maintenanceWindows: maintenanceWindows.length,
      agentKeys: agentKeys.length,
      notificationChannels: notificationChannels.length,
      invites: invites.length,
      healthChecks: healthChecks.length,
      auditLog: auditLog.length,
    },
    data: {
      users,
      servers,
      metrics,
      metricsHourly,
      containers,
      disks,
      sensors,
      alerts,
      maintenanceWindows,
      agentKeys,
      notificationChannels,
      invites,
      healthChecks,
      auditLog,
    },
  };
}

export type BackupBundle = Awaited<ReturnType<typeof exportBackup>>;

/**
 * Wipe + restore. Destructive: every table this function touches has its
 * rows replaced with the bundle's contents. Sessions are kept on the DB
 * but EVERY existing session is invalidated so the restoring browser is
 * the only one to survive (it's signed back in by the import handler).
 */
export async function importBackup(bundle: BackupBundle, opts: { keepSessionId?: string }) {
  if (!bundle || typeof bundle !== "object") throw new Error("invalid bundle");
  if (bundle.backupVersion !== BACKUP_VERSION) {
    throw new Error(`unsupported backup version ${bundle.backupVersion}`);
  }
  const d = bundle.data;
  if (!d) throw new Error("missing data block");

  // Order matters: child rows go before parents on delete, parents before
  // children on insert. With cascade FKs Prisma will delete dependents
  // automatically when we delete the parent — so we can delete parents only.
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.healthCheck.deleteMany(),
    prisma.invite.deleteMany(),
    prisma.notificationChannel.deleteMany(),
    prisma.agentKey.deleteMany(),
    prisma.maintenanceWindow.deleteMany(),
    prisma.alert.deleteMany(),
    prisma.sensor.deleteMany(),
    prisma.disk.deleteMany(),
    prisma.container.deleteMany(),
    prisma.metricHourly.deleteMany(),
    prisma.metric.deleteMany(),
    prisma.server.deleteMany(),
    // Sessions: drop every one except the importer's current session so
    // the admin doing the restore stays signed in.
    opts.keepSessionId
      ? prisma.session.deleteMany({ where: { NOT: { id: opts.keepSessionId } } })
      : prisma.session.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  // Bulk inserts. createMany is much faster than per-row create on Postgres
  // and works on SQLite via Prisma's emulation.
  await prisma.user.createMany({ data: d.users ?? [] });
  await prisma.server.createMany({ data: d.servers ?? [] });
  await prisma.metric.createMany({ data: d.metrics ?? [] });
  await prisma.metricHourly.createMany({ data: d.metricsHourly ?? [] });
  await prisma.container.createMany({ data: d.containers ?? [] });
  await prisma.disk.createMany({ data: d.disks ?? [] });
  await prisma.sensor.createMany({ data: d.sensors ?? [] });
  await prisma.alert.createMany({ data: d.alerts ?? [] });
  await prisma.maintenanceWindow.createMany({ data: d.maintenanceWindows ?? [] });
  await prisma.agentKey.createMany({ data: d.agentKeys ?? [] });
  await prisma.notificationChannel.createMany({ data: d.notificationChannels ?? [] });
  await prisma.invite.createMany({ data: d.invites ?? [] });
  await prisma.healthCheck.createMany({ data: d.healthChecks ?? [] });
  await prisma.auditLog.createMany({ data: d.auditLog ?? [] });
}
