import { Activity, AlertTriangle, Boxes, Cpu, HardDrive, MemoryStick, Network, Server as ServerIcon, Zap } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatCard, ProgressBar } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { formatPercent, formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

type ClusterInfo = {
  name: string;
  quorate: boolean;
  nodes: { name: string; online: boolean; local: boolean }[];
  expectedVotes?: number;
  totalVotes?: number;
  quorumNeeded?: number;
  qdevice?: boolean;
};

type PbsInfo = {
  datastores: {
    name: string;
    totalBytes?: number;
    usedBytes?: number;
    snapshots: number;
    lastBackupAt?: string;
  }[];
};

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

  // Cluster status: take the freshest non-null clusterInfo any node reported
  // (all members report the same view). null = no Proxmox cluster.
  let cluster: ClusterInfo | null = null;
  const clustered = servers
    .filter((s) => s.clusterInfo)
    .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
  if (clustered[0]?.clusterInfo) {
    try {
      cluster = JSON.parse(clustered[0].clusterInfo) as ClusterInfo;
    } catch {
      cluster = null;
    }
  }

  // PBS: freshest non-null pbsInfo from any node (the PBS host reports it).
  let pbs: PbsInfo | null = null;
  const pbsServers = servers
    .filter((s) => s.pbsInfo)
    .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
  if (pbsServers[0]?.pbsInfo) {
    try {
      pbs = JSON.parse(pbsServers[0].pbsInfo) as PbsInfo;
    } catch {
      pbs = null;
    }
  }

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
    cluster,
    pbs,
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

      {data.cluster ? <ClusterPanel cluster={data.cluster} /> : null}

      {data.pbs ? <PbsPanel pbs={data.pbs} /> : null}

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

function ClusterPanel({ cluster }: { cluster: ClusterInfo }) {
  const online = cluster.nodes.filter((n) => n.online).length;
  // 2-node cluster without a QDevice: if one node drops, the survivor loses
  // quorum and /etc/pve goes read-only. Surface that as the headline risk.
  const twoNodeNoQdevice = cluster.nodes.length === 2 && !cluster.qdevice;

  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Cluster</h2>
          <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[11px] text-primary">
            {cluster.name}
          </span>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            cluster.quorate
              ? "bg-success/15 text-success"
              : "bg-destructive/15 text-destructive"
          }`}
        >
          {cluster.quorate ? "Quorate" : "No quorum"}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          {cluster.nodes.map((n) => (
            <div key={n.name} className="flex items-center gap-2 text-sm">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  n.online ? "bg-success" : "bg-destructive"
                }`}
                title={n.online ? "online" : "offline"}
              />
              <span className="font-medium">{n.name}</span>
              {n.local ? (
                <span className="text-[11px] text-muted-foreground">(this node)</span>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {n.online ? "online" : "offline"}
              </span>
            </div>
          ))}
        </div>

        <div className="space-y-1.5 text-sm sm:border-l sm:border-border sm:pl-4">
          <Row label="Nodes online" value={`${online} / ${cluster.nodes.length}`} />
          {cluster.totalVotes != null ? (
            <Row
              label="Votes"
              value={`${cluster.totalVotes}${cluster.expectedVotes != null ? ` / ${cluster.expectedVotes}` : ""}${
                cluster.quorumNeeded != null ? ` · quorum ≥ ${cluster.quorumNeeded}` : ""
              }`}
            />
          ) : null}
          <Row label="QDevice" value={cluster.qdevice ? "present" : "none"} />
        </div>
      </div>

      {twoNodeNoQdevice ? (
        <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          2-node cluster zonder QDevice: valt één node weg, dan verliest de
          overlever quorum (/etc/pve read-only). Voeg een QDevice toe als derde
          stem — zie deploy/fase-9-ha.md.
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function PbsPanel({ pbs }: { pbs: PbsInfo }) {
  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Backups (PBS)</h2>
      </div>
      <div className="space-y-4">
        {pbs.datastores.map((ds) => {
          const pct =
            ds.totalBytes && ds.usedBytes != null ? (ds.usedBytes / ds.totalBytes) * 100 : null;
          return (
            <div key={ds.name}>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium">{ds.name}</span>
                <span className="text-xs text-muted-foreground">
                  {ds.snapshots} snapshot{ds.snapshots === 1 ? "" : "s"}
                  {ds.lastBackupAt
                    ? ` · last ${formatRelativeTime(new Date(ds.lastBackupAt))}`
                    : " · no backups yet"}
                </span>
              </div>
              <ProgressBar value={pct ?? 0} />
              <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                {ds.usedBytes != null && ds.totalBytes
                  ? `${formatBytes(ds.usedBytes)} / ${formatBytes(ds.totalBytes)}${
                      pct != null ? ` (${pct.toFixed(1)}%)` : ""
                    }`
                  : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
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
