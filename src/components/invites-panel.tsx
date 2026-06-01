"use client";

import { useEffect, useState } from "react";
import { Copy, Loader2, Mail, Trash2, UserPlus } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

type Invite = {
  id: string;
  emailHint: string | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  createdBy: { email: string } | null;
};

export function InvitesPanel() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [emailHint, setEmailHint] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ acceptUrl: string; emailHint: string | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/invites", { cache: "no-store" });
      const data = await res.json();
      setInvites(data.invites ?? []);
      setError(null);
    } catch {
      setError("failed to load invites");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(emailHint ? { emailHint } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `create failed (${res.status})`);
      }
      const data = await res.json();
      setRevealed({ acceptUrl: data.acceptUrl, emailHint: data.emailHint });
      setEmailHint("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this invite? The link will stop working immediately.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/invites/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(`revoke failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Invite users</h2>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Generate a single-use link valid for 7 days. Share it out of band
        (chat, password manager). The token is shown exactly once.
      </p>

      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          type="email"
          placeholder="Email hint (optional, prefills the form)"
          value={emailHint}
          onChange={(e) => setEmailHint(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          maxLength={255}
        />
        <button
          type="submit"
          disabled={creating}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Generate
        </button>
      </form>

      {revealed ? (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <Mail className="h-3.5 w-3.5" /> Invite link
            {revealed.emailHint ? (
              <span className="text-xs font-normal text-muted-foreground">
                for {revealed.emailHint}
              </span>
            ) : null}
          </div>
          <div className="mb-2 text-xs text-muted-foreground">
            Send this URL to the invitee. It will not be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-background p-2 font-mono text-xs">
              {revealed.acceptUrl}
            </code>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
              onClick={() => navigator.clipboard.writeText(revealed.acceptUrl)}
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setRevealed(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}

      {invites === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : invites.length === 0 ? (
        <div className="text-sm text-muted-foreground">No invites outstanding.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 text-left font-medium">For</th>
              <th className="py-2 text-left font-medium">Created</th>
              <th className="py-2 text-left font-medium">Expires</th>
              <th className="py-2 text-left font-medium">Status</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {invites.map((i) => (
              <tr key={i.id}>
                <td className="py-2">
                  {i.emailHint ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="py-2 text-muted-foreground">{formatRelativeTime(i.createdAt)}</td>
                <td className="py-2 text-muted-foreground">{formatRelativeTime(i.expiresAt)}</td>
                <td className="py-2">{statusFor(i)}</td>
                <td className="py-2 text-right">
                  {!i.usedAt ? (
                    <button
                      type="button"
                      disabled={busyId === i.id}
                      onClick={() => revoke(i.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {busyId === i.id ? (
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

function statusFor(i: Invite) {
  if (i.usedAt) return <span className="text-muted-foreground">used</span>;
  if (new Date(i.expiresAt) < new Date()) {
    return <span className="text-destructive">expired</span>;
  }
  return <span className="text-success">active</span>;
}
