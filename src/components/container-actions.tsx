"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Square, RotateCw, ScrollText, Loader2, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogStreamViewer } from "@/components/log-stream-viewer";

type Action = "start" | "stop" | "restart";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

/**
 * Wait for a job to reach a terminal state. Polls /api/jobs/<id> until status
 * is "done" or "error", or until the timeout fires. Returns the final job
 * payload (with parsed `result`), or throws if the job never completes.
 */
async function waitForJob(jobId: string, signal?: AbortSignal) {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error("aborted");
    const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`job poll -> ${res.status}`);
    const job = await res.json();
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("job timed out (agent may be offline)");
}

export function ContainerActions({
  id,
  name,
  status,
}: {
  id: string;
  name: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | "logs" | "stream" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ lines: string[]; error?: string } | null>(null);
  const [streamJobId, setStreamJobId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const running = status.toLowerCase() === "running";

  async function call(action: Action) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/containers/${id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { jobId } = await res.json();
      const job = await waitForJob(jobId);
      if (job.status === "error") {
        throw new Error(extractError(job.result));
      }
      // Successful action — refresh server-rendered list. The next agent tick
      // will sync the real container status; until then the UI is briefly
      // stale by up to 30s. That's acceptable for MVP.
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function startStream() {
    setBusy("stream");
    setError(null);
    try {
      const res = await fetch(`/api/containers/${id}/logs/stream`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { jobId } = await res.json();
      setStreamJobId(jobId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function fetchLogs() {
    setBusy("logs");
    setError(null);
    setLogs(null);
    try {
      const res = await fetch(`/api/containers/${id}/logs`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { jobId } = await res.json();
      const job = await waitForJob(jobId);
      if (job.status === "error") {
        setLogs({ lines: [], error: extractError(job.result) });
      } else {
        const lines: string[] = Array.isArray(job.result?.lines) ? job.result.lines : [];
        setLogs({ lines });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <IconButton
        title={`Start ${name}`}
        disabled={running || busy !== null}
        loading={busy === "start"}
        onClick={() => call("start")}
      >
        <Play className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        title={`Stop ${name}`}
        disabled={!running || busy !== null}
        loading={busy === "stop"}
        onClick={() => call("stop")}
      >
        <Square className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        title={`Restart ${name}`}
        disabled={busy !== null}
        loading={busy === "restart"}
        onClick={() => call("restart")}
      >
        <RotateCw className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        title={`Logs for ${name}`}
        disabled={busy !== null}
        loading={busy === "logs"}
        onClick={fetchLogs}
      >
        <ScrollText className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        title={`Live logs for ${name}`}
        disabled={!running || busy !== null}
        loading={busy === "stream"}
        onClick={startStream}
      >
        <Radio className="h-3.5 w-3.5" />
      </IconButton>

      {streamJobId ? (
        <LogStreamViewer
          jobId={streamJobId}
          containerName={name}
          onClose={() => setStreamJobId(null)}
        />
      ) : null}

      {error ? (
        <span className="ml-2 max-w-[16rem] truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      ) : null}

      {logs ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"
          onClick={() => setLogs(null)}
        >
          <div
            className="w-full max-w-2xl rounded-xl border border-border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Logs · {name}</h3>
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setLogs(null)}
              >
                close
              </button>
            </div>
            {logs.error ? (
              <div className="rounded bg-destructive/10 p-3 text-xs text-destructive">
                {logs.error}
              </div>
            ) : (
              <pre className="max-h-96 overflow-auto rounded bg-background p-3 text-left font-mono text-xs leading-relaxed">
                {logs.lines.length === 0 ? "(no output)" : logs.lines.join("\n")}
              </pre>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function extractError(result: unknown): string {
  if (result && typeof result === "object" && "error" in result) {
    const e = (result as { error: unknown }).error;
    if (typeof e === "string" && e.length > 0) return e;
  }
  return "agent reported an error";
}

function IconButton({
  children,
  loading,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-background disabled:hover:text-muted-foreground",
      )}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}
