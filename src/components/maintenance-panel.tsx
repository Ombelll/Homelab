"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Loader2, Trash2 } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

type ServerOption = { id: string; name: string; hostname: string };

type Window = {
  id: string;
  serverId: string | null;
  serverName: string | null;
  reason: string | null;
  startsAt: string;
  endsAt: string;
  active: boolean;
  createdAt: string;
};

export function MaintenancePanel() {
  const [windows, setWindows] = useState<Window[] | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [serverId, setServerId] = useState<string>("");
  const [reason, setReason] = useState("");
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date()));
  const [endsAt, setEndsAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const [w, s] = await Promise.all([
        fetch("/api/maintenance-windows", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/servers", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setWindows(w.windows ?? []);
      setServers((s.servers ?? []).map((srv: ServerOption) => srv));
      setError(null);
    } catch {
      setError("failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/maintenance-windows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: serverId || null,
          reason: reason || undefined,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `create failed (${res.status})`);
      }
      setReason("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this maintenance window?")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/maintenance-windows/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Maintenance windows</h2>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        While a window is active, new alerts on the targeted server (or all
        servers, if scope is global) are suppressed. Severities still update
        in the UI, just no notifications.
      </p>

      <form onSubmit={create} className="mb-4 grid gap-3 sm:grid-cols-4">
        <select
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
          className={inputClass}
        >
          <option value="">All servers (global)</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.hostname})
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          className={inputClass}
        />
        <input
          type="datetime-local"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          className={inputClass}
        />
        <input
          type="text"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
          maxLength={255}
        />
        <button
          type="submit"
          disabled={creating}
          className="col-span-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 sm:col-span-4 sm:max-w-fit"
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Schedule
        </button>
      </form>

      {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}

      {windows === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : windows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No windows scheduled.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 text-left font-medium">Scope</th>
              <th className="py-2 text-left font-medium">Window</th>
              <th className="py-2 text-left font-medium">Reason</th>
              <th className="py-2 text-left font-medium">State</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {windows.map((w) => (
              <tr key={w.id}>
                <td className="py-2">
                  {w.serverName ?? <span className="text-muted-foreground">global</span>}
                </td>
                <td className="py-2 text-muted-foreground">
                  {fmt(w.startsAt)} → {fmt(w.endsAt)}
                </td>
                <td className="py-2 text-muted-foreground">
                  {w.reason ?? "—"}
                </td>
                <td className="py-2">
                  {w.active ? (
                    <span className="text-warning">active</span>
                  ) : new Date(w.endsAt) < new Date() ? (
                    <span className="text-muted-foreground">past</span>
                  ) : (
                    <span className="text-muted-foreground">
                      in {formatRelativeTime(w.startsAt).replace(" ago", "")}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={busyId === w.id}
                    onClick={() => remove(w.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    {busyId === w.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}
