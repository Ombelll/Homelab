"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Edit3, Loader2, Power, RefreshCw, Trash2 } from "lucide-react";

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
  serverName,
  initialMac,
  serverStatus,
}: {
  serverId: string;
  serverName: string;
  initialMac: string | null;
  serverStatus: string;
}) {
  const router = useRouter();
  const [mac, setMac] = useState(initialMac ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"save" | "wake" | "update" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");

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

  async function remove() {
    setBusy("delete");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/servers/${serverId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `delete failed (${res.status})`);
      }
      // Gone — leave the (now-404) detail page.
      router.push("/servers");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function updateAgent() {
    setBusy("update");
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/update-agent`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `update failed (${res.status})`);
      setSuccess("Update queued. The agent will pull, rebuild, and restart — back online in ~1 minute.");
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <div>
          <h2 className="text-sm font-semibold">Agent</h2>
          <p className="text-xs text-muted-foreground">
            Pull the latest code, rebuild, and restart this host&apos;s agent.
          </p>
        </div>
        <button
          type="button"
          disabled={busy === "update"}
          onClick={updateAgent}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {busy === "update" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Update agent
        </button>
      </div>

      <div className="mt-4 border-t border-destructive/30 pt-4">
        <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Permanently remove this server and all its history (metrics,
          containers, alerts). Stop or disable its agent first — otherwise the
          next check-in re-creates it.
        </p>
        {confirmDelete ? (
          <div className="mt-3 space-y-2">
            <label className="block text-xs text-muted-foreground">
              Type the server name <span className="font-mono text-foreground">{serverName}</span> to confirm:
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={serverName}
                className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-destructive"
              />
              <button
                type="button"
                disabled={busy === "delete" || confirmText !== serverName}
                onClick={remove}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy === "delete" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Delete server
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  setConfirmText("");
                  setError(null);
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/20"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove server…
          </button>
        )}
      </div>
    </div>
  );
}
