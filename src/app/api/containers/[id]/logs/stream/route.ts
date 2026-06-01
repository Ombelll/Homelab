import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/**
 * Start a live log stream for this container. Returns the job id; the UI
 * then opens an EventSource against /api/jobs/<id>/stream and the agent
 * starts posting chunks to /api/agent/jobs/<id>/chunk.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const container = await prisma.container.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, dockerId: true, serverId: true },
  });
  if (!container) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = await enqueueJob({
    serverId: container.serverId,
    type: "container.logs.stream",
    payload: { dockerId: container.dockerId, containerName: container.name, tail: 100 },
  });

  return NextResponse.json({ jobId: job.id });
}
