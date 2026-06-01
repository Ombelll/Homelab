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
});

export const metricsSchema = z.object({
  hostname: z.string().min(1).max(255),
  cpuPercent: z.number().min(0).max(100),
  memoryPercent: z.number().min(0).max(100),
  diskPercent: z.number().min(0).max(100),
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
  ports: z.array(containerPortSchema).default([]),
  composeProject: z.string().max(255).optional(),
  composeService: z.string().max(255).optional(),
  cpuPercent: z.number().min(0).max(10000).optional(),
  memoryBytes: z.number().min(0).optional(),
  memoryLimitBytes: z.number().min(0).optional(),
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

export type ContainerInput = z.infer<typeof containerInputSchema>;
