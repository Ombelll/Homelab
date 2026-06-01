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
  status: z.string().min(1),
  ports: z.array(containerPortSchema).default([]),
});

export const containerSyncSchema = z.object({
  hostname: z.string().min(1).max(255),
  containers: z.array(containerInputSchema),
});

export type ContainerInput = z.infer<typeof containerInputSchema>;
