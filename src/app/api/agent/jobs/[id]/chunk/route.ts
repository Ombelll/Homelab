import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";

export const dynamic = "force-dynamic";

const chunkSchema = z.object({
  hostname: z.string().min(1).max(255),
  seq: z.number().int().min(0),
  lines: z.array(z.string()).max(500),
});

/**
 * Streaming jobs (container.logs.stream) post their output here as a sequence
 * of chunks. The response tells the agent whether to keep streaming:
 *
 *   { continue: true }   — keep going
 *   { continue: false }  — dashboard cancelled (UI disconnected); tear down
 *
 * Each (jobId, seq) is unique; duplicate posts (from a flaky network) are
 * upserts so the agent can safely retry the same chunk.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await verifyAgentKey(request))) return unauthorized();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = chunkSchema.safeParse(json);
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
  if (job.server.hostname !== parsed.data.hostname) {
    return NextResponse.json({ error: "hostname mismatch" }, { status: 403 });
  }

  // Dashboard requested cancel — don't write more chunks.
  if (job.status === "cancel") {
    return NextResponse.json({ continue: false });
  }
  if (job.status !== "inflight") {
    return NextResponse.json({ continue: false });
  }

  // Empty lines = heartbeat: lets an idle stream learn that the dashboard
  // wants it to stop. We just answer continue=true without polluting the
  // LogChunk table.
  if (parsed.data.lines.length > 0) {
    await prisma.logChunk.upsert({
      where: { jobId_seq: { jobId: job.id, seq: parsed.data.seq } },
      update: { lines: JSON.stringify(parsed.data.lines) },
      create: {
        jobId: job.id,
        seq: parsed.data.seq,
        lines: JSON.stringify(parsed.data.lines),
      },
    });
  }

  return NextResponse.json({ continue: true });
}
