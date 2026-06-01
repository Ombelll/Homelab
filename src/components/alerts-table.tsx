"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellOff, Check, Clock, Loader2 } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

type Alert = {
  id: string;
  severity: string;
  type: string;
  message: string;
  resolved: boolean;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  serverName: string | null;
};

export function AlertsTable({ alerts }: { alerts: Alert[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function call(id: string, path: string, body?: unknown) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/alerts/${id}/${path}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${path} failed (${res.status})`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (alerts.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No alerts on file.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <Th>Severity</Th>
            <Th>Type</Th>
            <Th>Server</Th>
            <Th>Message</Th>
            <Th>State</Th>
            <Th>When</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {alerts.map((a) => {
            const snoozed = a.snoozedUntil && new Date(a.snoozedUntil) > new Date();
            return (
              <tr key={a.id} className="hover:bg-muted/20">
                <Td><StatusBadge status={a.severity} /></Td>
                <Td className="font-mono text-xs">{a.type}</Td>
                <Td>{a.serverName ?? <span className="text-muted-foreground">system</span>}</Td>
                <Td>{a.message}</Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1">
                    {a.resolved ? (
                      <StatusBadge status="online" />
                    ) : (
                      <StatusBadge status="warning" />
                    )}
                    <span className="text-xs text-muted-foreground">
                      {a.resolved ? "resolved" : "open"}
                    </span>
                    {a.acknowledgedAt ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        ack
                      </span>
                    ) : null}
                    {snoozed ? (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning">
                        snoozed
                      </span>
                    ) : null}
                  </div>
                </Td>
                <Td className="text-muted-foreground">{formatRelativeTime(a.createdAt)}</Td>
                <Td className="text-right">
                  <div className="inline-flex gap-1.5">
                    {!a.resolved && !a.acknowledgedAt ? (
                      <ActionBtn
                        title="Acknowledge"
                        disabled={busyId === a.id}
                        loading={busyId === a.id}
                        onClick={() => call(a.id, "ack")}
                      >
                        <Check className="h-3 w-3" />
                      </ActionBtn>
                    ) : null}
                    {!a.resolved ? (
                      <ActionBtn
                        title={snoozed ? "Clear snooze" : "Snooze 1h"}
                        disabled={busyId === a.id}
                        loading={busyId === a.id}
                        onClick={() => call(a.id, "snooze", { minutes: snoozed ? 0 : 60 })}
                      >
                        {snoozed ? <BellOff className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                      </ActionBtn>
                    ) : null}
                    {!a.resolved ? (
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => call(a.id, "resolve")}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                      >
                        Resolve
                      </button>
                    ) : null}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("px-4 py-3 text-left font-medium", className)}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}

function ActionBtn({
  children,
  title,
  loading,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : children}
    </button>
  );
}
