"use client";

import { useEffect, useState } from "react";
import { History, Loader2, Search } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

type Entry = {
  id: string;
  userId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
};

export function AuditLogPanel() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (action) qs.set("action", action);
      if (actor) qs.set("actor", actor);
      const res = await fetch(`/api/audit-log?${qs.toString()}`, { cache: "no-store" });
      const data = await res.json();
      setEntries(data.entries ?? []);
      setError(null);
    } catch {
      setError("failed to load audit log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Audit log</h2>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
        className="mb-3 flex flex-wrap gap-2"
      >
        <input
          placeholder="filter by action (e.g. container)"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          placeholder="filter by actor email"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          Filter
        </button>
      </form>

      {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}

      {entries === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">No entries match.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 text-left font-medium">When</th>
              <th className="py-2 text-left font-medium">Actor</th>
              <th className="py-2 text-left font-medium">Action</th>
              <th className="py-2 text-left font-medium">Target</th>
              <th className="py-2 text-left font-medium">Details</th>
              <th className="py-2 text-left font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="py-2 text-muted-foreground">{formatRelativeTime(e.createdAt)}</td>
                <td className="py-2">
                  {e.actorEmail ? (
                    <span>{e.actorEmail}</span>
                  ) : (
                    <span className="text-muted-foreground">system</span>
                  )}
                </td>
                <td className="py-2 font-mono text-xs">{e.action}</td>
                <td className="py-2 font-mono text-xs text-muted-foreground">{e.target ?? "—"}</td>
                <td className="py-2 max-w-md truncate font-mono text-[11px] text-muted-foreground">
                  {e.metadata ? JSON.stringify(e.metadata) : "—"}
                </td>
                <td className="py-2 text-xs text-muted-foreground">{e.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
