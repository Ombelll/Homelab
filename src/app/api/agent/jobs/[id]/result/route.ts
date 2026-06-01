import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";

export const dynamic = "force-dynamic";

const resultSchema = z.object({
  hostname: z.string().min(1).max(255),
  status: z.enum(["done", "error"]),
  // Free-form result body. The dashboard treats it as opaque JSON and renders
  // the parts it knows about (e.g. `lines` for log jobs).
  result: z.unknown().optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await verifyAgentKey(request))) return unauthorized();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = resultSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const job = await prisma.job.findUnique({
    where: { id: params.id },
    include: { server: true },
  });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Hostname must match the server that owns this job — an agent on host A
  // cannot complete a job for host B even with a valid shared key.
  if (job.server.hostname !== parsed.data.hostname) {
    return NextResponse.json({ error: "hostname mismatch" }, { status: 403 });
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: parsed.data.status,
      result: parsed.data.result == null ? null : JSON.stringify(parsed.data.result),
      completedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true });
}
