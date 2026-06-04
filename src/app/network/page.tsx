import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { Sparkline } from "@/components/sparkline";
import { formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getDevices() {
  return prisma.networkDevice.findMany({
    orderBy: { name: "asc" },
    include: {
      ports: { orderBy: { ifIndex: "asc" } },
      samples: { orderBy: { at: "desc" }, take: 60 },
    },
  });
}

function formatBps(bps: number | null | undefined): string {
  if (bps == null) return "—";
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  const units = ["KiB/s", "MiB/s", "GiB/s"];
  let v = bps / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

function formatSpeed(mbps: number | null | undefined): string {
  if (mbps == null || mbps <= 0) return "—";
  if (mbps >= 1000) return `${(mbps / 1000) % 1 === 0 ? mbps / 1000 : (mbps / 1000).toFixed(1)} Gb`;
  return `${mbps} Mb`;
}

function formatUptime(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default async function NetworkPage() {
  const devices = await getDevices();

  return (
    <>
      <PageHeader
        title="Network"
        description="Managed switches and other devices polled over SNMP by an agent."
      />

      {devices.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">No SNMP devices yet.</p>
          <p className="mb-3">
            SNMP polling is dormant until you point an agent at a device. On a host whose agent
            should poll the switch, set these in <code>/etc/homelab-agent.env</code> and restart
            the agent:
          </p>
          <pre className="overflow-x-auto rounded-md border border-border bg-background/60 p-3 text-xs">
{`AGENT_SNMP_TARGET=192.168.1.x      # switch IP
AGENT_SNMP_COMMUNITY=homelab       # SNMP v2c community`}
          </pre>
          <p className="mt-3">
            Enable SNMP (v2c) with that community in the switch&apos;s web UI first.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {devices.map((dev) => {
            const up = dev.ports.filter((p) => p.status === "up").length;
            const totalRx = dev.ports.reduce((a, p) => a + (p.rxBps ?? 0), 0);
            const totalTx = dev.ports.reduce((a, p) => a + (p.txBps ?? 0), 0);
            const errPorts = dev.ports.filter((p) => (p.errDelta ?? 0) > 0).length;
            // Total-throughput trend (last ~60 polls), normalised to 0–100 for
            // the fixed-axis sparkline.
            const series = dev.samples.slice().reverse().map((s) => s.rxBps + s.txBps);
            const sMax = Math.max(1, ...series);
            const spark = series.map((v) => (v / sMax) * 100);
            return (
              <div key={dev.id} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{dev.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{dev.host}</span>
                    {dev.vendor ? (
                      <span className="truncate text-xs text-muted-foreground">· {dev.vendor}</span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{up} / {dev.ports.length} up</span>
                    <span className="tabular-nums">↓ {formatBps(totalRx)} · ↑ {formatBps(totalTx)}</span>
                    {spark.length >= 2 ? <Sparkline values={spark} width={90} height={20} tone="primary" /> : null}
                    {errPorts > 0 ? (
                      <span className="text-warning">{errPorts} port{errPorts === 1 ? "" : "s"} w/ errors</span>
                    ) : null}
                    <span>uptime {formatUptime(dev.uptimeSec)}</span>
                    <span>seen {formatRelativeTime(dev.lastSeenAt)}</span>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Port</th>
                      <th className="px-4 py-2 text-left font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Speed</th>
                      <th className="px-4 py-2 text-right font-medium">↓ Rx</th>
                      <th className="px-4 py-2 text-right font-medium">↑ Tx</th>
                      <th className="px-4 py-2 text-right font-medium" title="New errors + discards since the last poll">Errors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dev.ports.map((p) => {
                      const isUp = p.status === "up";
                      const disabled = p.adminUp === false;
                      const recent = p.errDelta ?? 0;
                      const lifetime =
                        (p.inErrors ?? 0) + (p.outErrors ?? 0) + (p.inDiscards ?? 0) + (p.outDiscards ?? 0);
                      // A gigabit-class port that negotiated below 1 Gb is worth flagging.
                      const slow = isUp && p.speedMbps != null && p.speedMbps > 0 && p.speedMbps < 1000;
                      const statusLabel = disabled ? "disabled" : p.status;
                      const statusClass = disabled
                        ? "bg-muted px-1.5 py-0.5 text-muted-foreground"
                        : isUp
                          ? "bg-success/15 px-1.5 py-0.5 text-success"
                          : "bg-destructive/15 px-1.5 py-0.5 text-destructive";
                      return (
                        <tr key={p.id} className="hover:bg-muted/20">
                          <td className="px-4 py-2 font-mono text-xs">{p.name}</td>
                          <td className="px-4 py-2">
                            <span className={`rounded text-[10px] uppercase tracking-wide ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </td>
                          <td
                            className={
                              slow
                                ? "px-4 py-2 text-right tabular-nums text-warning"
                                : "px-4 py-2 text-right tabular-nums text-muted-foreground"
                            }
                            title={slow ? "Negotiated below 1 Gb" : undefined}
                          >
                            {isUp ? formatSpeed(p.speedMbps) : "—"}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                            {isUp ? formatBps(p.rxBps) : "—"}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                            {isUp ? formatBps(p.txBps) : "—"}
                          </td>
                          <td
                            className={
                              recent > 0
                                ? "px-4 py-2 text-right tabular-nums font-medium text-warning"
                                : "px-4 py-2 text-right tabular-nums text-muted-foreground"
                            }
                            title={`${lifetime} total since boot`}
                          >
                            {recent > 0 ? `+${recent}` : "0"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
