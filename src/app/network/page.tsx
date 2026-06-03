import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getDevices() {
  return prisma.networkDevice.findMany({
    orderBy: { name: "asc" },
    include: { ports: { orderBy: { ifIndex: "asc" } } },
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
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{up} / {dev.ports.length} ports up</span>
                    <span>uptime {formatUptime(dev.uptimeSec)}</span>
                    <span>seen {formatRelativeTime(dev.lastSeenAt)}</span>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Port</th>
                      <th className="px-4 py-2 text-left font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">↓ Rx</th>
                      <th className="px-4 py-2 text-right font-medium">↑ Tx</th>
                      <th className="px-4 py-2 text-right font-medium">Errors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dev.ports.map((p) => {
                      const errs = (p.inErrors ?? 0) + (p.outErrors ?? 0);
                      const isUp = p.status === "up";
                      return (
                        <tr key={p.id} className="hover:bg-muted/20">
                          <td className="px-4 py-2 font-mono text-xs">{p.name}</td>
                          <td className="px-4 py-2">
                            <span
                              className={
                                isUp
                                  ? "rounded bg-success/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success"
                                  : "rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                              }
                            >
                              {p.status}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                            {isUp ? formatBps(p.rxBps) : "—"}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                            {isUp ? formatBps(p.txBps) : "—"}
                          </td>
                          <td
                            className={
                              errs > 0
                                ? "px-4 py-2 text-right tabular-nums text-warning"
                                : "px-4 py-2 text-right tabular-nums text-muted-foreground"
                            }
                          >
                            {errs > 0 ? errs : "0"}
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
