import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { AlertsTable } from "@/components/alerts-table";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const rows = await prisma.alert.findMany({
    orderBy: [{ resolved: "asc" }, { createdAt: "desc" }],
    take: 100,
    include: { server: { select: { name: true } } },
  });
  const alerts = rows.map((a) => ({
    id: a.id,
    severity: a.severity,
    type: a.type,
    message: a.message,
    resolved: a.resolved,
    acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
    snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    serverName: a.server?.name ?? null,
  }));

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Open + recent alerts. Ack to mute upgrade-notifications, snooze to silence for an hour, resolve to close manually."
        actions={
          <Link
            href="/alerts/analytics"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            <BarChart3 className="h-3.5 w-3.5" /> Analytics
          </Link>
        }
      />
      <AlertsTable alerts={alerts} />
    </>
  );
}
