import { z } from "zod";

export const SERVER_STATUS = ["online", "offline", "warning", "critical"] as const;
export const ALERT_SEVERITY = ["info", "warning", "critical"] as const;

export type ServerStatus = (typeof SERVER_STATUS)[number];
export type AlertSeverity = (typeof ALERT_SEVERITY)[number];

export const checkinSchema = z.object({
  hostname: z.string().min(1).max(255),
  name: z.string().min(1).max(255).optional(),
  ipAddress: z.string().max(64).optional(),
  os: z.string().max(255).optional(),
  status: z.enum(SERVER_STATUS).optional(),
  // System metadata — all optional so older agents keep working.
  bootAt: z.string().datetime().optional(),
  loadAvg: z.tuple([z.number(), z.number(), z.number()]).optional(),
  rebootRequired: z.boolean().optional(),
});

export const networkRateSchema = z.object({
  iface: z.string().min(1).max(64),
  rxBps: z.number().min(0),
  txBps: z.number().min(0),
});

export const metricsSchema = z.object({
  hostname: z.string().min(1).max(255),
  cpuPercent: z.number().min(0).max(100),
  memoryPercent: z.number().min(0).max(100),
  diskPercent: z.number().min(0).max(100),
  // Per-interface bytes/sec — agent computes the delta locally. We store
  // the latest snapshot on the Server row (no time-series for now).
  networkRates: z.array(networkRateSchema).max(32).optional(),
});

export const zfsPoolInputSchema = z.object({
  name: z.string().min(1).max(255),
  health: z.string().min(1).max(64),
  totalBytes: z.number().min(0),
  usedBytes: z.number().min(0),
  lastScrubAt: z.string().datetime().optional(),
});

export const zfsSyncSchema = z.object({
  hostname: z.string().min(1).max(255),
  pools: z.array(zfsPoolInputSchema).max(64),
});

export const containerPortSchema = z.object({
  host: z.string().optional(),
  container: z.string(),
  protocol: z.string().default("tcp"),
});

export const containerInputSchema = z.object({
  dockerId: z.string().min(1),
  name: z.string().min(1),
  image: z.string().min(1),
  imageDigest: z.string().max(255).optional(),
  status: z.string().min(1),
  health: z.string().max(32).optional(),
  ports: z.array(containerPortSchema).default([]),
  composeProject: z.string().max(255).optional(),
  composeService: z.string().max(255).optional(),
  cpuPercent: z.number().min(0).max(10000).optional(),
  memoryBytes: z.number().min(0).optional(),
  memoryLimitBytes: z.number().min(0).optional(),
  restartCount: z.number().int().min(0).optional(),
  oomKilled: z.boolean().optional(),
});

export const containerSyncSchema = z.object({
  hostname: z.string().min(1).max(255),
  containers: z.array(containerInputSchema),
});

export const diskInputSchema = z.object({
  mountpoint: z.string().min(1).max(512),
  fstype: z.string().max(64).optional(),
  totalBytes: z.number().min(0),
  usedBytes: z.number().min(0),
});

export const diskSyncSchema = z.object({
  hostname: z.string().min(1).max(255),
  disks: z.array(diskInputSchema).max(256),
});

export const sensorInputSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.string().min(1).max(32),
  value: z.number(),
  unit: z.string().max(16),
});

export const sensorSyncSchema = z.object({
  hostname: z.string().min(1).max(255),
  sensors: z.array(sensorInputSchema).max(128),
});

export const diskIoRateSchema = z.object({
  device: z.string().min(1).max(64),
  readBps: z.number().min(0),
  writeBps: z.number().min(0),
});

export const topProcessSchema = z.object({
  pid: z.number().int().min(0),
  name: z.string().min(1).max(128),
  // Per-core-normalised like `top`, so a multi-threaded process can exceed 100.
  cpuPercent: z.number().min(0).max(100000),
  memBytes: z.number().min(0),
});

export const smartDeviceSchema = z.object({
  device: z.string().min(1).max(128),
  model: z.string().max(255).optional(),
  serial: z.string().max(255).optional(),
  healthy: z.boolean(),
  tempC: z.number().optional(),
  powerOnHours: z.number().int().min(0).optional(),
  reallocatedSectors: z.number().int().min(0).optional(),
  wearPercent: z.number().int().min(0).max(255).optional(),
  mediaErrors: z.number().int().min(0).optional(),
  criticalWarning: z.number().int().min(0).optional(),
  availableSparePercent: z.number().int().min(0).max(100).optional(),
  selfTestStatus: z.string().max(128).optional(),
});

export const upsSchema = z.object({
  name: z.string().min(1).max(64),
  status: z.string().min(1).max(64),
  batteryPercent: z.number().min(0).max(100).optional(),
  loadPercent: z.number().min(0).max(1000).optional(),
  runtimeSec: z.number().min(0).optional(),
  inputVoltage: z.number().min(0).optional(),
});

// Combined per-tick payload — the agent sends everything in one POST to
// /api/agent/report instead of five separate calls. Every section beyond the
// three core gauges is optional, so a partial collection (one collector
// failing on the host) still produces a valid report.
export const reportSchema = z.object({
  hostname: z.string().min(1).max(255),
  cpuPercent: z.number().min(0).max(100),
  memoryPercent: z.number().min(0).max(100),
  diskPercent: z.number().min(0).max(100),
  swapPercent: z.number().min(0).max(100).optional(),
  cpuPerCore: z.array(z.number().min(0).max(100)).max(256).optional(),
  processCount: z.number().int().min(0).optional(),
  failedUnits: z.number().int().min(0).optional(),
  backupAgeHours: z.number().min(0).optional(),
  backupBytes: z.number().min(0).optional(),
  powerWatts: z.number().min(0).max(2000).optional(),
  networkRates: z.array(networkRateSchema).max(32).optional(),
  diskIoRates: z.array(diskIoRateSchema).max(64).optional(),
  topProcesses: z.array(topProcessSchema).max(16).optional(),
  containers: z.array(containerInputSchema).optional(),
  disks: z.array(diskInputSchema).max(256).optional(),
  sensors: z.array(sensorInputSchema).max(128).optional(),
  zfsPools: z.array(zfsPoolInputSchema).max(64).optional(),
  smartDevices: z.array(smartDeviceSchema).max(64).optional(),
  ups: upsSchema.optional(),
});

export type ContainerInput = z.infer<typeof containerInputSchema>;

// SNMP report from an agent that polled a network device (managed switch).
export const snmpPortSchema = z.object({
  ifIndex: z.number().int().min(0),
  name: z.string().min(1).max(128),
  status: z.string().min(1).max(32),
  adminUp: z.boolean().optional(),
  speedMbps: z.number().int().min(0).max(1_000_000).optional(),
  rxBps: z.number().min(0).optional(),
  txBps: z.number().min(0).optional(),
  inErrors: z.number().int().min(0).optional(),
  outErrors: z.number().int().min(0).optional(),
  inDiscards: z.number().int().min(0).optional(),
  outDiscards: z.number().int().min(0).optional(),
});

export const logLineSchema = z.object({
  source: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  at: z.string().datetime().optional(),
});

export const logsReportSchema = z.object({
  hostname: z.string().min(1).max(255),
  lines: z.array(logLineSchema).max(1000),
});

export const snmpReportSchema = z.object({
  host: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  vendor: z.string().max(255).optional(),
  uptimeSec: z.number().int().min(0).optional(),
  ports: z.array(snmpPortSchema).max(256),
});
