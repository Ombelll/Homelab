import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs";
import { requireAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

// Enqueues a logs job for the host agent. The UI polls /api/jobs/<id> until
// the agent posts back lines in the result.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const container = await prisma.container.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, dockerId: true, serverId: true },
  });
  if (!container) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = await enqueueJob({
    serverId: container.serverId,
    type: "container.logs",
    payload: { dockerId: container.dockerId, containerName: container.name, tail: 200 },
  });

  return NextResponse.json({ jobId: job.id, status: job.status });
}
