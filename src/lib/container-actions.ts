import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export type ContainerAction = "start" | "stop" | "restart";

/**
 * Placeholder Docker control flow.
 *
 * SECURITY: We deliberately do NOT exec `docker` against the host or talk to
 * the Docker socket from the dashboard. Mounting /var/run/docker.sock into the
 * dashboard container is effectively root-equivalent: anyone who can reach the
 * dashboard could spawn privileged containers, mount the host filesystem, and
 * escape. The intended design is:
 *
 *   dashboard  --(authenticated job queue)-->  per-host agent  -->  docker
 *
 * For MVP these endpoints update DB state optimistically and return a stub
 * jobId. Wire the real path when the agent grows a command channel — see
 * AGENTS.md → "Future Docker control flow".
 */
export async function dispatchContainerAction(id: string, action: ContainerAction) {
  const container = await prisma.container.findUnique({
    where: { id },
    include: { server: true },
  });

  if (!container) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const nextStatus = action === "stop" ? "exited" : "running";

  await prisma.container.update({
    where: { id },
    data: { status: nextStatus },
  });

  // TODO: enqueue real job for the host agent (see AGENTS.md).
  const jobId = `mock-${action}-${Date.now()}`;

  return NextResponse.json({
    ok: true,
    mocked: true,
    jobId,
    action,
    container: { id: container.id, name: container.name, status: nextStatus },
  });
}
