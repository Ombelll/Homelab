import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
// SSE needs Node runtime; the Edge runtime has different streaming semantics
// and no Prisma support.
export const runtime = "nodejs";

const POLL_INTERVAL_MS = 500;
const HEARTBEAT_MS = 15_000;

/**
 * Server-Sent Events stream of LogChunk rows for a streaming job.
 *
 * Events emitted:
 *   - data: { lines: string[], seq: number }  — appended chunk
 *   - event: "status", data: { status }       — job state changed
 *   - heartbeat comment lines every 15s       — keeps proxies happy
 *
 * When the client disconnects (EventSource.close or tab navigation) the
 * request's AbortSignal fires; we flip the job to "cancel" so the agent
 * tears down its process on the next chunk post.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const job = await prisma.job.findUnique({ where: { id: params.id } });
  if (!job) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let lastSeq = -1;
  let lastStatus = job.status;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const onAbort = async () => {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        // Best-effort: ask the agent to stop streaming.
        await prisma.job
          .updateMany({
            where: { id: params.id, status: "inflight" },
            data: { status: "cancel" },
          })
          .catch(() => {});
      };
      request.signal.addEventListener("abort", onAbort);

      send(`retry: 5000\n\n`);
      send(`event: status\ndata: ${JSON.stringify({ status: lastStatus })}\n\n`);

      let lastHeartbeat = Date.now();

      while (!closed) {
        const fresh = await prisma.logChunk.findMany({
          where: { jobId: params.id, seq: { gt: lastSeq } },
          orderBy: { seq: "asc" },
          take: 200,
        });
        for (const c of fresh) {
          let lines: string[] = [];
          try {
            const parsed = JSON.parse(c.lines);
            if (Array.isArray(parsed)) lines = parsed;
          } catch {
            /* ignore */
          }
          send(`data: ${JSON.stringify({ seq: c.seq, lines })}\n\n`);
          lastSeq = c.seq;
        }

        const current = await prisma.job.findUnique({
          where: { id: params.id },
          select: { status: true },
        });
        if (current && current.status !== lastStatus) {
          lastStatus = current.status;
          send(`event: status\ndata: ${JSON.stringify({ status: lastStatus })}\n\n`);
          if (lastStatus === "done" || lastStatus === "error") {
            send(`event: end\ndata: {}\n\n`);
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
            break;
          }
        }

        if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
          send(`: heartbeat\n\n`);
          lastHeartbeat = Date.now();
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stop Nginx from buffering SSE responses.
      "x-accel-buffering": "no",
    },
  });
}
