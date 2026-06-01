import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ProgressBar } from "@/components/stat-card";
import { Sparkline } from "@/components/sparkline";
import { formatPercent, formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getData(id: string) {
  const server = await prisma.server.findUnique({
    where: { id },
    include: {
      metrics: { orderBy: { createdAt: "desc" }, take: 60 },
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

  // metrics come back newest-first; reverse for chart left-to-right
  const series = [...server.metrics].reverse();
  const latest = server.metrics[0];

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

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricPanel
          label="CPU"
          icon={Cpu}
          value={latest?.cpuPercent}
          values={series.map((m) => m.cpuPercent)}
        />
        <MetricPanel
          label="Memory"
          icon={MemoryStick}
          value={latest?.memoryPercent}
          values={series.map((m) => m.memoryPercent)}
        />
        <MetricPanel
          label="Disk"
          icon={HardDrive}
          value={latest?.diskPercent}
          values={series.map((m) => m.diskPercent)}
        />
      </div>

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
        Showing the most recent {series.length} samples · last seen {formatRelativeTime(server.lastSeenAt)}
      </p>
    </>
  );
}

function MetricPanel({
  label,
  icon: Icon,
  value,
  values,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: number | undefined;
  values: number[];
}) {
  const display = value == null ? "—" : formatPercent(value, 1);
  const tone = value == null ? "primary" : value >= 90 ? "destructive" : value >= 75 ? "warning" : "success";
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold tabular-nums">{display}</div>
        <Sparkline values={values} tone={tone} width={140} height={36} />
      </div>
      <div className="mt-3">
        <ProgressBar value={value ?? 0} />
      </div>
    </div>
  );
}
