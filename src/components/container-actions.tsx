"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Square, RotateCw, ScrollText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Action = "start" | "stop" | "restart";

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
  const [busy, setBusy] = useState<Action | "logs" | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [isPending, startTransition] = useTransition();

  const running = status.toLowerCase() === "running";

  async function call(action: Action) {
    setBusy(action);
    try {
      const res = await fetch(`/api/containers/${id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      startTransition(() => router.refresh());
    } catch (e) {
      console.error(`container ${action} failed`, e);
    } finally {
      setBusy(null);
    }
  }

  async function fetchLogs() {
    setBusy("logs");
    try {
      const res = await fetch(`/api/containers/${id}/logs`);
      const data = await res.json();
      setLogs(data.lines ?? []);
    } catch (e) {
      console.error("logs failed", e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <IconButton
        title={`Start ${name}`}
        disabled={running || busy !== null || isPending}
        loading={busy === "start"}
        onClick={() => call("start")}
      >
        <Play className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        title={`Stop ${name}`}
        disabled={!running || busy !== null || isPending}
        loading={busy === "stop"}
        onClick={() => call("stop")}
      >
        <Square className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        title={`Restart ${name}`}
        disabled={busy !== null || isPending}
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
            <pre className="max-h-96 overflow-auto rounded bg-background p-3 text-left font-mono text-xs leading-relaxed">
              {logs.length === 0 ? "(no output)" : logs.join("\n")}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
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
