import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseResult } from "@/lib/jobs";
import { requireAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const job = await prisma.job.findUnique({ where: { id: params.id } });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    result: parseResult(job.result),
    createdAt: job.createdAt,
    claimedAt: job.claimedAt,
    completedAt: job.completedAt,
  });
}
