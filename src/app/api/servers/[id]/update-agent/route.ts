import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs";
import { requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Enqueue a self-update job for the server's agent. The agent picks it up on
 * its next job poll and re-runs its install script (pull → rebuild → restart).
 * Admin-only; the agent then goes briefly offline while it restarts.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const server = await prisma.server.findUnique({
    where: { id: params.id },
    select: { id: true, name: true },
  });
  if (!server) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const job = await enqueueJob({ serverId: server.id, type: "agent.update" });

  void recordAudit({
    user: guard.user,
    action: "agent.update",
    target: `server:${server.id}`,
    metadata: { name: server.name, jobId: job.id },
  });

  return NextResponse.json({ ok: true, jobId: job.id, status: job.status });
}
