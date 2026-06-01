import { prisma } from "@/lib/prisma";

// Allowed job types. The dashboard never lets a caller name an arbitrary
// command — every type maps to a fixed behaviour on the agent side.
export const JOB_TYPES = [
  "container.start",
  "container.stop",
  "container.restart",
  "container.logs",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const TERMINAL_STATUSES = new Set(["done", "error"]);

/**
 * Insert a pending job for the given server. We avoid queueing a duplicate
 * if an identical (type, payload) job is already pending or in flight — this
 * makes repeated UI clicks idempotent without extra plumbing.
 */
export async function enqueueJob(input: {
  serverId: string;
  type: JobType;
  payload?: Record<string, unknown>;
}) {
  const payload = JSON.stringify(input.payload ?? {});

  const existing = await prisma.job.findFirst({
    where: {
      serverId: input.serverId,
      type: input.type,
      payload,
      status: { in: ["pending", "inflight"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return prisma.job.create({
    data: {
      serverId: input.serverId,
      type: input.type,
      payload,
    },
  });
}

export function parseResult(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
