"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

type Status = "connecting" | "live" | "ended" | "error";

/**
 * Modal viewer that subscribes to /api/jobs/<jobId>/stream over SSE and
 * appends incoming lines. Closing the viewer aborts the EventSource, which
 * triggers the SSE handler to flip the job to "cancel" so the agent stops.
 */
export function LogStreamViewer({
  jobId,
  containerName,
  onClose,
}: {
  jobId: string;
  containerName: string;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const preRef = useRef<HTMLPreElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${jobId}/stream`);

    es.onopen = () => setStatus("live");

    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { lines?: string[] };
        if (Array.isArray(data.lines) && data.lines.length > 0) {
          setLines((prev) => {
            const next = prev.concat(data.lines as string[]);
            // Cap memory; users can re-open for older history.
            return next.length > 5000 ? next.slice(-5000) : next;
          });
        }
      } catch {
        /* ignore malformed frame */
      }
    };

    es.addEventListener("status", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data);
        if (data.status === "done" || data.status === "error") {
          setStatus(data.status === "error" ? "error" : "ended");
        }
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("end", () => {
      es.close();
      setStatus((s) => (s === "error" ? s : "ended"));
    });

    es.onerror = () => {
      // EventSource auto-reconnects; only surface a sticky error after we've
      // already received the "end" event or the server closes definitively.
      if (es.readyState === EventSource.CLOSED) {
        setStatus((s) => (s === "ended" ? s : "error"));
      }
    };

    return () => {
      es.close();
    };
  }, [jobId]);

  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    if (stickToBottom.current) {
      pre.scrollTop = pre.scrollHeight;
    }
  }, [lines]);

  function onScroll(e: React.UIEvent<HTMLPreElement>) {
    const el = e.currentTarget;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl border border-border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Live logs · {containerName}</h3>
            <div className="mt-0.5 text-xs text-muted-foreground">
              <StatusBadge status={status} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
          >
            <X className="h-3 w-3" /> Close
          </button>
        </div>
        <pre
          ref={preRef}
          onScroll={onScroll}
          className="h-[60vh] overflow-auto rounded bg-background p-3 text-left font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 ? "(waiting for output…)" : lines.join("\n")}
        </pre>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "connecting") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> waiting for agent…
      </span>
    );
  }
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> live
      </span>
    );
  }
  if (status === "ended") {
    return <span className="text-muted-foreground">stream ended</span>;
  }
  return <span className="text-destructive">stream error</span>;
}
