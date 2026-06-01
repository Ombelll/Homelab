"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Edit3, Loader2, Power } from "lucide-react";

/**
 * Per-server controls visible on the detail page. Only renders for admins.
 *
 * Wake button is conditional on a configured MAC; otherwise the form is
 * the way in. Both POST against the dashboard, which sends the magic
 * packet from the dashboard host's network — so for cross-subnet wakes
 * you need to point the dashboard at the right LAN.
 */
export function ServerActions({
  serverId,
  initialMac,
  serverStatus,
}: {
  serverId: string;
  initialMac: string | null;
  serverStatus: string;
}) {
  const router = useRouter();
  const [mac, setMac] = useState(initialMac ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"save" | "wake" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function save() {
    setBusy("save");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/servers/${serverId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ macAddress: mac.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `save failed (${res.status})`);
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function wake() {
    setBusy("wake");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/wake`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `wake failed (${res.status})`);
      setSuccess("Magic packet sent. Server should boot within a minute.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Wake-on-LAN</h2>

      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            placeholder="aa:bb:cc:dd:ee:ff"
            className="min-w-[14rem] flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            disabled={busy === "save"}
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setMac(initialMac ?? "");
              setError(null);
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {initialMac ?? "no MAC configured"}
          </code>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
          >
            <Edit3 className="h-3 w-3" /> Edit
          </button>
          {initialMac && serverStatus !== "online" ? (
            <button
              type="button"
              disabled={busy === "wake"}
              onClick={wake}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === "wake" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              Wake
            </button>
          ) : null}
        </div>
      )}

      {error ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="mt-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {success}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        WoL packets are broadcast on the dashboard host&apos;s LAN. For
        cross-subnet wakes you need a relay on the target&apos;s subnet.
      </p>
    </div>
  );
}
