"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, Plus, Trash2 } from "lucide-react";
import { formatRelativeTime, cn } from "@/lib/utils";

type Check = {
  id: string;
  name: string;
  type: string;
  target: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number | null;
  enabled: boolean;
  lastStatus: string | null;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export function ServicesPanel({
  initialChecks,
  canEdit,
}: {
  initialChecks: Check[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function probe(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/health-checks/${id}/run`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(c: Check) {
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/health-checks/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      if (!res.ok) throw new Error(await res.text());
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this health check?")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/health-checks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {initialChecks.length} checks
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> {showForm ? "Cancel" : "Add check"}
          </button>
        ) : null}
      </div>

      {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}

      {showForm && canEdit ? <NewCheckForm onCreated={() => { setShowForm(false); refresh(); }} /> : null}

      {initialChecks.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No health checks yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Target</Th>
                <Th>Status</Th>
                <Th>Latency</Th>
                <Th>Last checked</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {initialChecks.map((c) => {
                const dot = c.lastStatus === "up" ? "bg-success" : c.lastStatus === "down" ? "bg-destructive" : "bg-muted-foreground";
                return (
                  <tr key={c.id} className={cn("hover:bg-muted/20", !c.enabled && "opacity-60")}>
                    <Td className="font-medium">{c.name}</Td>
                    <Td><span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase">{c.type}</span></Td>
                    <Td className="font-mono text-xs text-muted-foreground">{c.target}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
                        <span className="capitalize">{c.lastStatus ?? "never run"}</span>
                      </span>
                      {c.lastError ? (
                        <div className="mt-0.5 truncate text-[11px] text-destructive" title={c.lastError}>
                          {c.lastError}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-muted-foreground">
                      {c.lastLatencyMs != null ? `${c.lastLatencyMs} ms` : "—"}
                    </Td>
                    <Td className="text-muted-foreground">{formatRelativeTime(c.lastCheckedAt)}</Td>
                    <Td className="text-right">
                      <div className="inline-flex gap-1.5">
                        <button
                          type="button"
                          disabled={busyId === c.id}
                          onClick={() => probe(c.id)}
                          title="Probe now"
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                        >
                          {busyId === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                          Probe
                        </button>
                        {canEdit ? (
                          <>
                            <button
                              type="button"
                              disabled={busyId === c.id}
                              onClick={() => toggle(c)}
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                            >
                              {c.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              disabled={busyId === c.id}
                              onClick={() => remove(c.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("px-4 py-3 text-left font-medium", className)}>{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}

function NewCheckForm({ onCreated }: { onCreated: () => void }) {
  const [type, setType] = useState<"http" | "tcp" | "ping">("http");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("60");
  const [timeoutMs, setTimeoutMs] = useState("5000");
  const [expectedStatus, setExpectedStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/health-checks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          target,
          intervalSeconds: Number(intervalSeconds),
          timeoutMs: Number(timeoutMs),
          expectedStatus: type === "http" && expectedStatus ? Number(expectedStatus) : null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `create failed (${res.status})`);
      }
      setName("");
      setTarget("");
      setExpectedStatus("");
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 grid gap-3 rounded-md border border-border bg-card p-3 sm:grid-cols-3">
      <Field label="Name">
        <input className={inputClass} required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type">
        <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as "http" | "tcp" | "ping")}>
          <option value="http">HTTP/HTTPS</option>
          <option value="tcp">TCP</option>
          <option value="ping">Ping</option>
        </select>
      </Field>
      <Field label={type === "http" ? "URL" : type === "tcp" ? "host:port" : "host"}>
        <input
          className={inputClass}
          required
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={
            type === "http" ? "https://service.lan/health" : type === "tcp" ? "10.0.0.10:5432" : "10.0.0.10"
          }
        />
      </Field>
      <Field label="Interval (s)">
        <input className={inputClass} type="number" min={10} max={86400} value={intervalSeconds} onChange={(e) => setIntervalSeconds(e.target.value)} />
      </Field>
      <Field label="Timeout (ms)">
        <input className={inputClass} type="number" min={100} max={60000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
      </Field>
      {type === "http" ? (
        <Field label="Expected status (optional)">
          <input className={inputClass} type="number" min={100} max={599} value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value)} placeholder="default: 2xx/3xx" />
        </Field>
      ) : null}
      {error ? <div className="col-span-full text-sm text-destructive">{error}</div> : null}
      <button
        type="submit"
        disabled={busy}
        className="col-span-full inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Create
      </button>
    </form>
  );
}

const inputClass = "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
