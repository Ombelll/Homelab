import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getNodes() {
  return prisma.proxmoxNode.findMany({
    orderBy: { node: "asc" },
    include: {
      guests: { orderBy: [{ status: "asc" }, { vmid: "asc" }] },
    },
  });
}

function formatUptime(sec: number | null): string {
  if (sec == null || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// MiB → "x.x GiB" once it's worth it, else "n MiB".
function formatMiB(mib: number | null): string {
  if (mib == null) return "—";
  if (mib < 1024) return `${mib} MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GiB`;
}

function cpuPct(cpu: number | null): string {
  return cpu == null ? "—" : `${Math.round(cpu * 100)}%`;
}

// One cell in a node's stat grid (mirrors the /network router stat cells).
function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-card px-4 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-sm tabular-nums ${warn ? "font-medium text-warning" : "text-foreground"}`}>
        {value}
      </dd>
    </div>
  );
}

export default async function ProxmoxPage() {
  const nodes = await getNodes();

  return (
    <>
      <PageHeader
        title="Proxmox"
        description="Cluster nodes and guests (VMs + LXCs), polled read-only from the Proxmox API."
      />

      {nodes.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">No Proxmox data yet.</p>
          <p className="mb-3">
            Create a read-only API token in Proxmox (Datacenter → Permissions → API Tokens; give the
            user the <code>PVEAuditor</code> role on <code>/</code>), then set these in the dashboard&apos;s
            environment and let the poll route run:
          </p>
          <pre className="overflow-x-auto rounded-md border border-border bg-background/60 p-3 text-xs">
{`PROXMOX_API_URL=https://192.168.1.10:8006
PROXMOX_TOKEN_ID=monitor@pam!dashboard
PROXMOX_TOKEN_SECRET=<the token secret>

# schedule (every minute), alongside the other internal routes:
* * * * * curl -fsS -X POST http://dashboard/api/internal/poll-proxmox \\
            -H "x-sweep-key: $SWEEP_KEY" > /dev/null`}
          </pre>
          <p className="mt-3">
            The token is read-only (PVEAuditor) — this view never starts, stops, or changes anything.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {nodes.map((node) => {
            const memPct =
              node.memTotalMb && node.memUsedMb != null
                ? Math.round((node.memUsedMb / node.memTotalMb) * 100)
                : null;
            const running = node.guests.filter((g) => g.status === "running").length;
            return (
              <div key={node.id} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">node</span>
                    <span className="font-semibold">{node.node}</span>
                    <StatusBadge status={node.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {running}/{node.guests.length} guest{node.guests.length === 1 ? "" : "s"} running
                    </span>
                    <span>uptime {formatUptime(node.uptimeSec)}</span>
                    <span>seen {formatRelativeTime(node.lastSeenAt)}</span>
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
                  <Stat label="CPU" value={cpuPct(node.cpu)} warn={node.cpu != null && node.cpu >= 0.9} />
                  <Stat label="Cores" value={node.maxCpu != null ? String(node.maxCpu) : "—"} />
                  <Stat
                    label="Memory"
                    value={
                      node.memTotalMb
                        ? `${formatMiB(node.memUsedMb)} / ${formatMiB(node.memTotalMb)}${memPct != null ? ` (${memPct}%)` : ""}`
                        : "—"
                    }
                    warn={memPct != null && memPct >= 90}
                  />
                  <Stat label="Level" value={node.level && node.level.length > 0 ? node.level : "—"} />
                </dl>

                {node.guests.length > 0 ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2 font-medium">VMID</th>
                        <th className="px-4 py-2 font-medium">Name</th>
                        <th className="px-4 py-2 font-medium">Type</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">CPU</th>
                        <th className="px-4 py-2 font-medium">Memory</th>
                        <th className="px-4 py-2 font-medium">Uptime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {node.guests.map((g) => (
                        <tr key={g.id} className="border-t border-border/60">
                          <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">{g.vmid}</td>
                          <td className="px-4 py-2">
                            {g.name}
                            {g.template ? (
                              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                template
                              </span>
                            ) : null}
                            {g.tags ? (
                              <span className="ml-2 text-xs text-muted-foreground">{g.tags.replace(/;/g, " · ")}</span>
                            ) : null}
                          </td>
                          <td className="px-4 py-2 uppercase text-xs text-muted-foreground">{g.type}</td>
                          <td className="px-4 py-2">
                            <StatusBadge status={g.status} />
                          </td>
                          <td className="px-4 py-2 tabular-nums">{g.status === "running" ? cpuPct(g.cpu) : "—"}</td>
                          <td className="px-4 py-2 tabular-nums">
                            {g.status === "running"
                              ? `${formatMiB(g.memUsedMb)} / ${formatMiB(g.maxMemMb)}`
                              : formatMiB(g.maxMemMb)}
                          </td>
                          <td className="px-4 py-2 tabular-nums text-muted-foreground">
                            {g.status === "running" ? formatUptime(g.uptimeSec) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="px-4 py-3 text-xs text-muted-foreground">No guests on this node.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
