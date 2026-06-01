import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob, type JobType } from "@/lib/jobs";
import { requireAdmin } from "@/lib/authz";
import { recordAudit, type AuditAction } from "@/lib/audit";

export type ContainerAction = "start" | "stop" | "restart";

const ACTION_TO_JOB: Record<ContainerAction, JobType> = {
  start: "container.start",
  stop: "container.stop",
  restart: "container.restart",
};

/**
 * Enqueue a container action for the agent on the container's host. The
 * dashboard never executes `docker` itself — see AGENTS.md for the reasoning.
 *
 * Returns the job id; the UI then polls /api/jobs/<id> until it reaches a
 * terminal state.
 */
export async function dispatchContainerAction(id: string, action: ContainerAction) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const container = await prisma.container.findUnique({
    where: { id },
    select: { id: true, name: true, dockerId: true, serverId: true, status: true },
  });

  if (!container) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const job = await enqueueJob({
    serverId: container.serverId,
    type: ACTION_TO_JOB[action],
    payload: { dockerId: container.dockerId, containerName: container.name },
  });

  void recordAudit({
    user: guard.user,
    action: `container.${action}` as AuditAction,
    target: `container:${container.id}`,
    metadata: { name: container.name, dockerId: container.dockerId, jobId: job.id },
  });

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    action,
    container: { id: container.id, name: container.name },
  });
}
