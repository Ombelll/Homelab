import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ServerMetricsCharts } from "@/components/server-metrics-charts";
import { formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getData(id: string) {
  const server = await prisma.server.findUnique({
    where: { id },
    include: {
      containers: { orderBy: { name: "asc" } },
      alerts: {
        where: { resolved: false },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });
  return server;
}

export default async function ServerDetailPage({ params }: { params: { id: string } }) {
  const server = await getData(params.id);
  if (!server) notFound();

  return (
    <>
      <Link
        href="/servers"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back to servers
      </Link>

      <PageHeader
        title={server.name}
        description={`${server.hostname}${server.ipAddress ? ` · ${server.ipAddress}` : ""}${
          server.os ? ` · ${server.os}` : ""
        }`}
        actions={<StatusBadge status={server.status} />}
      />

      <ServerMetricsCharts serverId={server.id} />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Containers ({server.containers.length})</h2>
            <Link href="/containers" className="text-xs text-muted-foreground hover:text-foreground">
              manage →
            </Link>
          </div>
          {server.containers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No containers reported.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {server.containers.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2">
                  <div className="min-w-0">
                    <div className="font-medium">{c.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{c.image}</div>
                  </div>
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Open alerts ({server.alerts.length})</h2>
            <Link href="/alerts" className="text-xs text-muted-foreground hover:text-foreground">
              all →
            </Link>
          </div>
          {server.alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">All clear.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {server.alerts.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate">{a.message}</div>
                    <div className="text-xs text-muted-foreground">
                      {a.type} · {formatRelativeTime(a.createdAt)}
                    </div>
                  </div>
                  <StatusBadge status={a.severity} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Last seen {formatRelativeTime(server.lastSeenAt)}
      </p>
    </>
  );
}
