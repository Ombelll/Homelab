import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ContainerActions } from "@/components/container-actions";
import { Sparkline } from "@/components/sparkline";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Port = { host?: string; container: string; protocol?: string };

async function getContainers() {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const [rows, samples] = await Promise.all([
    prisma.container.findMany({
      orderBy: [{ composeProject: "asc" }, { status: "asc" }, { name: "asc" }],
      include: { server: { select: { name: true, hostname: true } } },
    }),
    prisma.containerSample.findMany({
      where: { at: { gte: since } },
      select: { serverId: true, name: true, cpuPercent: true, memoryBytes: true },
      orderBy: { at: "asc" },
    }),
  ]);
  // Bucket the last 6h of samples per (server, container).
  const cpuBy = new Map<string, number[]>();
  const memBy = new Map<string, number[]>();
  for (const s of samples) {
    const k = `${s.serverId}::${s.name}`;
    if (s.cpuPercent != null) (cpuBy.get(k) ?? cpuBy.set(k, []).get(k)!).push(s.cpuPercent);
    if (s.memoryBytes != null) (memBy.get(k) ?? memBy.set(k, []).get(k)!).push(s.memoryBytes);
  }
  return rows.map((c) => {
    let ports: Port[] = [];
    try {
      const parsed = JSON.parse(c.ports);
      if (Array.isArray(parsed)) ports = parsed;
    } catch {
      ports = [];
    }
    const k = `${c.serverId}::${c.name}`;
    return { ...c, ports, cpuSeries: cpuBy.get(k) ?? [], memSeries: memBy.get(k) ?? [] };
  });
}

type Container = Awaited<ReturnType<typeof getContainers>>[number];

export default async function ContainersPage() {
  const [containers, user] = await Promise.all([getContainers(), getCurrentUser()]);
  const canControl = user?.role === "admin";

  // Group by (server, composeProject). Containers without a compose project
  // get a synthetic "standalone" group per server so they render last.
  const groups = new Map<string, Container[]>();
  for (const c of containers) {
    const key = `${c.server.hostname}::${c.composeProject ?? "__standalone__"}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  return (
    <>
      <PageHeader
        title="Containers"
        description="Docker containers reported by each host's agent. Grouped by compose project where available."
      />

      {containers.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No containers reported yet.
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(groups.entries()).map(([key, list]) => {
            const [hostname, project] = key.split("::");
            const isStandalone = project === "__standalone__";
            return (
              <Group
                key={key}
                hostname={hostname}
                project={isStandalone ? null : project}
                containers={list}
                canControl={canControl}
              />
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        {canControl
          ? "Actions enqueue a job for the host agent and wait up to 30 seconds for the result."
          : "Your viewer role can read container state but not control it."}{" "}
        See <code>AGENTS.md</code> for the protocol.
      </p>
    </>
  );
}

function Group({
  hostname,
  project,
  containers,
  canControl,
}: {
  hostname: string;
  project: string | null;
  containers: Container[];
  canControl: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2 text-xs">
        <div className="flex items-center gap-2">
          {project ? (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[11px] text-primary">
              {project}
            </span>
          ) : (
            <span className="text-muted-foreground">standalone</span>
          )}
          <span className="text-muted-foreground">on {hostname}</span>
        </div>
        <div className="text-muted-foreground">
          {containers.filter((c) => c.status === "running").length} / {containers.length} running
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <Th>Name</Th>
            <Th>Image</Th>
            <Th>Status</Th>
            <Th>CPU</Th>
            <Th>Memory</Th>
            <Th>Ports</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {containers.map((c) => (
            <tr key={c.id} className="hover:bg-muted/20">
              <Td className="font-medium">
                <div className="flex items-center gap-1.5">
                  <span>{c.name}</span>
                  {c.restartCount != null && c.restartCount >= 5 ? (
                    <span
                      title={`${c.restartCount} restarts since creation`}
                      className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-destructive"
                    >
                      ⟳ {c.restartCount}
                    </span>
                  ) : null}
                </div>
                {c.composeService ? (
                  <div className="text-[11px] text-muted-foreground">{c.composeService}</div>
                ) : null}
              </Td>
              <Td className="font-mono text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span>{c.image}</span>
                  {c.updateAvailable ? (
                    <span
                      title={`Newer image available on the registry${
                        c.lastUpdateCheck ? ` (checked ${new Date(c.lastUpdateCheck).toLocaleString()})` : ""
                      }`}
                      className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
                    >
                      update
                    </span>
                  ) : null}
                </div>
              </Td>
              <Td><StatusBadge status={c.status} /></Td>
              <Td className="tabular-nums">
                <div className="flex items-center gap-2">
                  <span>
                    {c.cpuPercent != null
                      ? `${c.cpuPercent.toFixed(1)}%`
                      : <span className="text-muted-foreground">—</span>}
                  </span>
                  {c.cpuSeries.length >= 2 ? (
                    <Sparkline values={c.cpuSeries} width={56} height={16} tone="primary" />
                  ) : null}
                </div>
              </Td>
              <Td className="tabular-nums">
                <div className="flex items-center gap-2">
                  <span>
                    {c.memoryBytes != null
                      ? formatBytes(c.memoryBytes) +
                        (c.memoryLimitBytes ? ` / ${formatBytes(c.memoryLimitBytes)}` : "")
                      : <span className="text-muted-foreground">—</span>}
                  </span>
                  {c.memSeries.length >= 2 ? (
                    <Sparkline values={c.memSeries} width={56} height={16} tone="primary" />
                  ) : null}
                </div>
              </Td>
              <Td>
                {c.ports.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {c.ports.map((p, i) => (
                      <span
                        key={i}
                        className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                      >
                        {p.host ? `${p.host}:` : ""}
                        {p.container}/{p.protocol ?? "tcp"}
                      </span>
                    ))}
                  </div>
                )}
              </Td>
              <Td className="text-right">
                {canControl ? (
                  <ContainerActions id={c.id} name={c.name} status={c.status} />
                ) : (
                  <span className="text-xs text-muted-foreground">view only</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-3 text-left font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
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
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}
