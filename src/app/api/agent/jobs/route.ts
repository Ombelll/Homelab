import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  hostname: z.string().min(1).max(255),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

/**
 * Agents call this on a short interval. We atomically claim up to `limit`
 * pending jobs for the calling host: status flips to "inflight" so a second
 * poll (or a parallel agent process) won't pick them up.
 *
 * If a job sits in "inflight" longer than 60s without a result it is
 * reclaimed on the next poll, so a crashed agent doesn't leave jobs stuck.
 */
export async function GET(request: Request) {
  if (!(await verifyAgentKey(request))) return unauthorized();

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    hostname: url.searchParams.get("hostname"),
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid query", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { hostname, limit = 5 } = parsed.data;

  const server = await prisma.server.findUnique({ where: { hostname } });
  if (!server) {
    return NextResponse.json(
      { error: "unknown server, call /api/agent/checkin first" },
      { status: 404 },
    );
  }

  const reclaimCutoff = new Date(Date.now() - 60 * 1000);
  const candidates = await prisma.job.findMany({
    where: {
      serverId: server.id,
      OR: [
        { status: "pending" },
        { status: "inflight", claimedAt: { lt: reclaimCutoff } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const now = new Date();
  const claimed: Array<{ id: string; type: string; payload: unknown }> = [];

  for (const job of candidates) {
    // Optimistic claim: only update if still pending or stuck. If two pollers
    // race we just lose this row to the other — that's fine.
    const res = await prisma.job.updateMany({
      where: {
        id: job.id,
        OR: [
          { status: "pending" },
          { status: "inflight", claimedAt: { lt: reclaimCutoff } },
        ],
      },
      data: { status: "inflight", claimedAt: now },
    });
    if (res.count === 1) {
      claimed.push({ id: job.id, type: job.type, payload: safeParse(job.payload) });
    }
  }

  return NextResponse.json({ jobs: claimed });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
