"use client";

import { useRef, useState } from "react";
import { Database, Download, Loader2, Upload } from "lucide-react";

export function BackupPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function exportNow() {
    // Direct navigation to the download endpoint — browser will save the
    // attachment based on the Content-Disposition header. We don't bother
    // with fetch+blob because we don't need to show progress.
    setBusy("export");
    setError(null);
    setSuccess(null);
    try {
      window.location.href = "/api/internal/backup";
      setSuccess("Backup download started.");
    } finally {
      // Reset busy after a moment so the spinner doesn't get stuck.
      setTimeout(() => setBusy(null), 1500);
    }
  }

  async function importNow(file: File) {
    if (
      !confirm(
        `Restore from "${file.name}"? This wipes the current data (servers, alerts, channels, etc.) and replaces it with the bundle. Your current session is kept.`,
      )
    ) {
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setBusy("import");
    setError(null);
    setSuccess(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/internal/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `restore failed (${res.status})`);
      }
      setSuccess("Restore complete. Refresh to see the imported state.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Database className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Backup &amp; restore</h2>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Export a JSON snapshot of every dashboard table (sessions and
        transient logs are excluded). Restore wipes the current data and
        loads the bundle in its place — keep this for new deployments and
        disaster recovery, not for routine state migration.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={exportNow}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Download backup
        </button>

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          {busy === "import" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Restore from file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importNow(file);
          }}
        />
      </div>

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
    </div>
  );
}
