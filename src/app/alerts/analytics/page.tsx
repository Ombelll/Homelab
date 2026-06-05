import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export default async function AlertAnalyticsPage() {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const alerts = await prisma.alert.findMany({
    where: { createdAt: { gte: since } },
    select: { type: true, severity: true, resolved: true, createdAt: true, resolvedAt: true },
  });

  type Row = { type: string; total: number; open: number; mttrSumMs: number; mttrCount: number };
  const byType = new Map<string, Row>();
  const bySeverity = new Map<string, number>();
  for (const a of alerts) {
    const r = byType.get(a.type) ?? { type: a.type, total: 0, open: 0, mttrSumMs: 0, mttrCount: 0 };
    r.total++;
    if (!a.resolved) r.open++;
    if (a.resolved && a.resolvedAt) {
      r.mttrSumMs += a.resolvedAt.getTime() - a.createdAt.getTime();
      r.mttrCount++;
    }
    byType.set(a.type, r);
    bySeverity.set(a.severity, (bySeverity.get(a.severity) ?? 0) + 1);
  }
  const rows = [...byType.values()].sort((a, b) => b.total - a.total);
  const totalAlerts = alerts.length;
  const totalOpen = alerts.filter((a) => !a.resolved).length;

  return (
    <>
      <Link
        href="/alerts"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back to alerts
      </Link>
      <PageHeader
        title="Alert analytics"
        description={`Which alerts fire most and how long they stay open, over the last ${WINDOW_DAYS} days. Use it to tune thresholds and cut noise.`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Alerts (30d)" value={String(totalAlerts)} />
        <Stat label="Currently open" value={String(totalOpen)} tone={totalOpen > 0 ? "warning" : "default"} />
        <Stat label="Critical" value={String(bySeverity.get("critical") ?? 0)} tone={(bySeverity.get("critical") ?? 0) > 0 ? "destructive" : "default"} />
        <Stat label="Warning" value={String(bySeverity.get("warning") ?? 0)} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No alerts in the last {WINDOW_DAYS} days. Quiet is good.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Alert type</th>
                <th className="px-4 py-3 text-right font-medium">Fired</th>
                <th className="px-4 py-3 text-right font-medium">Open now</th>
                <th className="px-4 py-3 text-right font-medium">Avg time-to-resolve</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.type} className="hover:bg-muted/20">
                  <td className="px-4 py-3 font-mono text-xs">{r.type}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.total}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${r.open > 0 ? "text-warning" : "text-muted-foreground"}`}>
                    {r.open}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {r.mttrCount > 0 ? fmtDuration(r.mttrSumMs / r.mttrCount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        A type firing often with a short time-to-resolve is usually a flapping
        threshold worth loosening; one that stays open long may need a real fix.
        Time-to-resolve is only available for alerts resolved since this feature
        shipped.
      </p>
    </>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "warning" | "destructive" }) {
  const color = tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-amber-500" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
