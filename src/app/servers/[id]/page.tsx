import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ServerMetricsCharts } from "@/components/server-metrics-charts";
import { ServerActions } from "@/components/server-actions";
import { getCurrentUser } from "@/lib/session";
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
      disks: { orderBy: { mountpoint: "asc" } },
      sensors: { orderBy: [{ kind: "asc" }, { name: "asc" }] },
      zfsPools: { orderBy: { name: "asc" } },
    },
  });
  return server;
}

// Parse JSON columns defensively — never crash the page if an older agent
// wrote something unexpected.
function parseJsonField<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function formatBps(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  const units = ["KiB/s", "MiB/s", "GiB/s"];
  let v = bps / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

function formatUptime(bootAt: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - bootAt.getTime()) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default async function ServerDetailPage({ params }: { params: { id: string } }) {
  const [server, user] = await Promise.all([getData(params.id), getCurrentUser()]);
  if (!server) notFound();
  const isAdmin = user?.role === "admin";

  const loadAvg = parseJsonField<[number, number, number]>(server.loadAvg);
  const networkRates = parseJsonField<Array<{ iface: string; rxBps: number; txBps: number }>>(
    server.networkRates,
  );

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
        actions={
          <div className="flex items-center gap-2">
            {server.rebootRequired ? (
              <span
                title={
                  server.rebootRequiredSince
                    ? `Reboot requested since ${formatRelativeTime(server.rebootRequiredSince)}`
                    : "Reboot requested"
                }
                className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning"
              >
                ⟳ reboot required
              </span>
            ) : null}
            <StatusBadge status={server.status} />
          </div>
        }
      />

      {/* System snapshot row: uptime, load, network. Hidden entirely
          if the agent hasn't reported any of these yet. */}
      {server.bootAt || loadAvg || networkRates?.length ? (
        <div className="mb-6 grid gap-2 rounded-xl border border-border bg-card p-3 text-xs sm:grid-cols-3">
          <div>
            <div className="mb-0.5 text-muted-foreground">Uptime</div>
            <div className="font-medium">
              {server.bootAt ? formatUptime(server.bootAt) : "—"}
            </div>
          </div>
          <div>
            <div className="mb-0.5 text-muted-foreground">Load average</div>
            <div className="tabular-nums font-medium">
              {loadAvg ? `${loadAvg[0]} · ${loadAvg[1]} · ${loadAvg[2]}` : "—"}
            </div>
          </div>
          <div>
            <div className="mb-0.5 text-muted-foreground">Network</div>
            <div className="space-y-0.5">
              {networkRates && networkRates.length > 0 ? (
                networkRates.map((n) => (
                  <div key={n.iface} className="font-medium">
                    <span className="font-mono text-muted-foreground">{n.iface}:</span>{" "}
                    ↓ {formatBps(n.rxBps)} · ↑ {formatBps(n.txBps)}
                  </div>
                ))
              ) : (
                "—"
              )}
            </div>
          </div>
        </div>
      ) : null}

      <ServerMetricsCharts serverId={server.id} />

      {isAdmin ? (
        <div className="mt-6">
          <ServerActions
            serverId={server.id}
            initialMac={server.macAddress}
            serverStatus={server.status}
          />
        </div>
      ) : null}

      {server.zfsPools.length > 0 ? (
        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">ZFS pools ({server.zfsPools.length})</h2>
          <ul className="space-y-3 text-sm">
            {server.zfsPools.map((pool) => {
              const pct = pool.totalBytes > 0 ? (pool.usedBytes / pool.totalBytes) * 100 : 0;
              const healthy = pool.health === "ONLINE";
              const barTone = pct >= 90 ? "destructive" : pct >= 80 ? "warning" : "success";
              return (
                <li key={pool.id}>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{pool.name}</span>
                      <span
                        className={
                          healthy
                            ? "rounded bg-success/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success"
                            : "rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-destructive"
                        }
                      >
                        {pool.health}
                      </span>
                    </div>
                    <span className="tabular-nums text-muted-foreground">
                      {formatBytes(pool.usedBytes)} / {formatBytes(pool.totalBytes)} · {pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={
                        barTone === "destructive"
                          ? "h-full bg-destructive"
                          : barTone === "warning"
                            ? "h-full bg-warning"
                            : "h-full bg-success"
                      }
                      style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {server.disks.length > 0 || server.sensors.length > 0 ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {server.disks.length > 0 ? (
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="mb-3 text-sm font-semibold">Disks ({server.disks.length})</h2>
              <ul className="space-y-3 text-sm">
                {server.disks.map((d) => {
                  const pct = d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0;
                  const tone = pct >= 90 ? "destructive" : pct >= 80 ? "warning" : "success";
                  return (
                    <li key={d.id}>
                      <div className="flex items-center justify-between text-xs">
                        <div className="min-w-0">
                          <span className="font-mono">{d.mountpoint}</span>
                          {d.fstype ? (
                            <span className="ml-1.5 text-muted-foreground">({d.fstype})</span>
                          ) : null}
                        </div>
                        <span className="tabular-nums text-muted-foreground">
                          {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)} · {pct.toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={
                            tone === "destructive"
                              ? "h-full bg-destructive"
                              : tone === "warning"
                                ? "h-full bg-warning"
                                : "h-full bg-success"
                          }
                          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {server.sensors.length > 0 ? (
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="mb-3 text-sm font-semibold">Sensors ({server.sensors.length})</h2>
              <ul className="grid grid-cols-2 gap-2 text-sm">
                {server.sensors.map((s) => {
                  const tone =
                    s.kind === "temperature" && s.value >= 80
                      ? "destructive"
                      : s.kind === "temperature" && s.value >= 65
                        ? "warning"
                        : "muted";
                  return (
                    <li
                      key={s.id}
                      className="flex items-center justify-between rounded-md border border-border bg-background/40 px-2 py-1.5"
                    >
                      <div className="min-w-0 truncate text-xs text-muted-foreground" title={s.name}>
                        {s.name}
                      </div>
                      <div
                        className={
                          tone === "destructive"
                            ? "tabular-nums text-destructive"
                            : tone === "warning"
                              ? "tabular-nums text-warning"
                              : "tabular-nums"
                        }
                      >
                        {s.value} {s.unit}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}
