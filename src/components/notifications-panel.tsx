"use client";

import { useEffect, useState } from "react";
import { Bell, Loader2, Send, Trash2 } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

type ChannelType = "discord" | "ntfy" | "webhook";

type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  minSeverity: "info" | "warning" | "critical";
  config: Record<string, unknown>;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export function NotificationsPanel() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/notification-channels", { cache: "no-store" });
      const data = await res.json();
      setChannels(data.channels ?? []);
      setError(null);
    } catch {
      setError("failed to load channels");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function test(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/notification-channels/${id}/test`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `test failed (${res.status})`);
      alert("Test notification sent. Check your channel.");
      await load();
    } catch (e) {
      alert(`Test failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this channel? Alerts will stop being sent to it.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/notification-channels/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(`delete failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(c: Channel) {
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/notification-channels/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(`toggle failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Bell className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Notification channels</h2>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        When a CPU/memory/disk threshold trips or a server goes offline, every
        enabled channel here gets a message — Discord webhook, ntfy topic, or
        a generic JSON webhook.
      </p>

      {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}

      <button
        type="button"
        onClick={() => setShowForm((v) => !v)}
        className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
      >
        {showForm ? "Cancel" : "Add channel"}
      </button>

      {showForm ? (
        <NewChannelForm
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
        />
      ) : null}

      {channels === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : channels.length === 0 ? (
        <div className="text-sm text-muted-foreground">No channels configured.</div>
      ) : (
        <ul className="space-y-2">
          {channels.map((c) => (
            <li key={c.id} className="rounded-md border border-border bg-background/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase text-muted-foreground">
                      {c.type}
                    </span>
                    <span className="text-xs text-muted-foreground">≥ {c.minSeverity}</span>
                    {!c.enabled ? <span className="text-xs text-warning">disabled</span> : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {summary(c.config)}
                  </div>
                  {c.lastError ? (
                    <div className="mt-1 text-xs text-destructive" title={c.lastError}>
                      last error: {c.lastError}
                    </div>
                  ) : c.lastUsedAt ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      last used {formatRelativeTime(c.lastUsedAt)}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-shrink-0 gap-1.5">
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
                    onClick={() => test(c.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    {busyId === c.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Send className="h-3 w-3" />
                    )}
                    Test
                  </button>
                  <button
                    type="button"
                    disabled={busyId === c.id}
                    onClick={() => remove(c.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function summary(config: Record<string, unknown>): string {
  const entries = Object.entries(config).filter(([k]) => k !== "secretSet");
  if (entries.length === 0) return "(no config)";
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
}

function NewChannelForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("discord");
  const [minSeverity, setMinSeverity] = useState<"info" | "warning" | "critical">("warning");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Type-specific fields.
  const [webhookUrl, setWebhookUrl] = useState("");
  const [ntfyServer, setNtfyServer] = useState("https://ntfy.sh");
  const [ntfyTopic, setNtfyTopic] = useState("");
  const [ntfyToken, setNtfyToken] = useState("");
  const [webhookGenericUrl, setWebhookGenericUrl] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let config: Record<string, unknown> = {};
      if (type === "discord") config = { webhookUrl };
      if (type === "ntfy") config = ntfyToken
        ? { server: ntfyServer, topic: ntfyTopic, token: ntfyToken }
        : { server: ntfyServer, topic: ntfyTopic };
      if (type === "webhook") config = { url: webhookGenericUrl };

      const res = await fetch("/api/notification-channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, type, minSeverity, config }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `create failed (${res.status})`);
      }
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 space-y-3 rounded-md border border-border bg-background/40 p-3"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={64}
          />
        </Field>
        <Field label="Type">
          <select
            className={inputClass}
            value={type}
            onChange={(e) => setType(e.target.value as ChannelType)}
          >
            <option value="discord">Discord webhook</option>
            <option value="ntfy">ntfy</option>
            <option value="webhook">Generic JSON webhook</option>
          </select>
        </Field>
        <Field label="Minimum severity">
          <select
            className={inputClass}
            value={minSeverity}
            onChange={(e) => setMinSeverity(e.target.value as "info" | "warning" | "critical")}
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
        </Field>
      </div>

      {type === "discord" ? (
        <Field label="Webhook URL">
          <input
            type="url"
            className={inputClass}
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://discord.com/api/webhooks/…"
            required
          />
        </Field>
      ) : null}

      {type === "ntfy" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Server">
            <input
              type="url"
              className={inputClass}
              value={ntfyServer}
              onChange={(e) => setNtfyServer(e.target.value)}
            />
          </Field>
          <Field label="Topic">
            <input
              className={inputClass}
              value={ntfyTopic}
              onChange={(e) => setNtfyTopic(e.target.value)}
              required
            />
          </Field>
          <Field label="Access token (optional)">
            <input
              type="password"
              className={inputClass}
              value={ntfyToken}
              onChange={(e) => setNtfyToken(e.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {type === "webhook" ? (
        <Field label="URL">
          <input
            type="url"
            className={inputClass}
            value={webhookGenericUrl}
            onChange={(e) => setWebhookGenericUrl(e.target.value)}
            required
          />
        </Field>
      ) : null}

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Create
      </button>
    </form>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
