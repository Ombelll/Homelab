"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, Trash2 } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

type Key = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export function AgentKeysPanel() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ label: string; key: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/agent-keys", { cache: "no-store" });
      const data = await res.json();
      setKeys(data.keys ?? []);
      setError(null);
    } catch {
      setError("failed to load keys");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/agent-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRevealed({ label: data.label, key: data.key });
      setLabel("");
      await load();
    } catch (err) {
      setError(`create failed: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Any agent using it will be locked out immediately.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/agent-keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (err) {
      setError(`revoke failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Agent API keys</h2>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Per-agent keys are matched (SHA-256 hashed) in addition to the{" "}
        <code>AGENT_API_KEY</code> env var. Use these to give each host its own
        revokable credential.
      </p>

      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          type="text"
          placeholder="Label (e.g. bravo.lan)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          maxLength={64}
        />
        <button
          type="submit"
          disabled={creating || !label.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Generate
        </button>
      </form>

      {revealed ? (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <div className="mb-2 font-medium">New key for &ldquo;{revealed.label}&rdquo;</div>
          <div className="mb-2 text-xs text-muted-foreground">
            Copy it now — it will not be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-background p-2 font-mono text-xs">
              {revealed.key}
            </code>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
              onClick={() => navigator.clipboard.writeText(revealed.key)}
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setRevealed(null)}
          >
            I&rsquo;ve saved it
          </button>
        </div>
      ) : null}

      {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}

      {keys === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : keys.length === 0 ? (
        <div className="text-sm text-muted-foreground">No keys yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 text-left font-medium">Label</th>
              <th className="py-2 text-left font-medium">Created</th>
              <th className="py-2 text-left font-medium">Last used</th>
              <th className="py-2 text-left font-medium">Status</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {keys.map((k) => (
              <tr key={k.id}>
                <td className="py-2 font-medium">{k.label}</td>
                <td className="py-2 text-muted-foreground">{formatRelativeTime(k.createdAt)}</td>
                <td className="py-2 text-muted-foreground">{formatRelativeTime(k.lastUsedAt)}</td>
                <td className="py-2">
                  {k.revokedAt ? (
                    <span className="text-destructive">revoked</span>
                  ) : (
                    <span className="text-success">active</span>
                  )}
                </td>
                <td className="py-2 text-right">
                  {!k.revokedAt ? (
                    <button
                      type="button"
                      disabled={busyId === k.id}
                      onClick={() => revoke(k.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {busyId === k.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                      Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
