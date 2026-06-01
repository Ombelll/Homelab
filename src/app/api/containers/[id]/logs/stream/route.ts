import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs";
import { requireAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

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
    type: "container.logs.stream",
    payload: { dockerId: container.dockerId, containerName: container.name, tail: 100 },
  });

  return NextResponse.json({ jobId: job.id });
}
