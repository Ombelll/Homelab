import { Activity, AlertTriangle, Boxes, Cpu, HardDrive, MemoryStick, Server as ServerIcon, Zap } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatCard, ProgressBar } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { formatPercent, formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getDashboardData() {
  const [servers, containers, alerts] = await Promise.all([
    prisma.server.findMany({
      include: { metrics: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    prisma.container.findMany({ select: { status: true } }),
    prisma.alert.findMany({
      where: { resolved: false },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { server: { select: { name: true } } },
    }),
  ]);

  const online = servers.filter((s) => s.status === "online").length;
  const warning = servers.filter((s) => s.status === "warning").length;
  const critical = servers.filter((s) => s.status === "critical").length;
  const offline = servers.filter((s) => s.status === "offline").length;

  const liveMetrics = servers
    .map((s) => s.metrics[0])
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  const avg = (key: "cpuPercent" | "memoryPercent" | "diskPercent") =>
    liveMetrics.length === 0
      ? null
      : liveMetrics.reduce((acc, m) => acc + m[key], 0) / liveMetrics.length;

  const running = containers.filter((c) => c.status === "running").length;

  // Fleet-wide power draw: sum the latest per-server snapshot (RAPL on hosts
  // that expose it). null when no host reports power at all.
  const powerServers = servers.filter((s) => s.powerWatts != null);
  const totalWatts =
    powerServers.length === 0
      ? null
      : powerServers.reduce((acc, s) => acc + (s.powerWatts ?? 0), 0);

  return {
    totals: { servers: servers.length, online, warning, critical, offline },
    avg: { cpu: avg("cpuPercent"), mem: avg("memoryPercent"), disk: avg("diskPercent") },
    containers: { total: containers.length, running },
    power: { totalWatts, hosts: powerServers.length },
    alerts,
  };
}

export default async function DashboardPage() {
  const data = await getDashboardData();

  const powerPrice = Number(process.env.POWER_PRICE_EUR_PER_KWH ?? "0.34") || 0.34;
  const w = data.power.totalWatts;
  const powerValue = w == null ? "—" : `${w.toFixed(0)} W`;
  const powerHint =
    w == null
      ? "no power data yet"
      : `~${((w * 24) / 1000).toFixed(1)} kWh/d · €${(((w * 24) / 1000) * 30 * powerPrice).toFixed(0)}/mnd`;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Real-time overview of every host the agent has checked in from."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Servers" value={data.totals.servers} icon={ServerIcon}
          hint={`${data.totals.online} online, ${data.totals.offline} offline`} />
        <StatCard label="Warnings" value={data.totals.warning} icon={AlertTriangle}
          tone={data.totals.warning > 0 ? "warning" : "default"} />
        <StatCard label="Critical" value={data.totals.critical} icon={Activity}
          tone={data.totals.critical > 0 ? "destructive" : "default"} />
        <StatCard label="Containers" value={`${data.containers.running} / ${data.containers.total}`}
          icon={Boxes} hint="running / total" />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ResourceCard label="Avg CPU" value={data.avg.cpu} icon={Cpu} />
        <ResourceCard label="Avg Memory" value={data.avg.mem} icon={MemoryStick} />
        <ResourceCard label="Avg Disk" value={data.avg.disk} icon={HardDrive} />
        <StatCard label="Power" value={powerValue} icon={Zap} hint={powerHint} />
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent alerts</h2>
          <span className="text-xs text-muted-foreground">{data.alerts.length} open</span>
        </div>
        {data.alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open alerts. Nice and quiet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.alerts.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={a.severity} />
                    <span className="truncate text-sm">{a.message}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {a.server?.name ?? "system"} · {a.type} · {formatRelativeTime(a.createdAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ResourceCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | null;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const display = value == null ? "—" : formatPercent(value, 1);
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{display}</div>
      <div className="mt-3">
        <ProgressBar value={value ?? 0} />
      </div>
    </div>
  );
}
