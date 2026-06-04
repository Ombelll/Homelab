import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ServerMetricsCharts } from "@/components/server-metrics-charts";
import { ServerActions } from "@/components/server-actions";
import { Sparkline } from "@/components/sparkline";
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
      smartDevices: { orderBy: { device: "asc" } },
      // Latest metric row for the extended gauges (swap, per-core CPU,
      // process count, failed units) that aren't on the Server snapshot.
      metrics: { orderBy: { createdAt: "desc" }, take: 1 },
      // Recent UPS battery samples for the sparkline.
      upsSamples: { orderBy: { at: "desc" }, take: 60 },
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
  const diskIoRates = parseJsonField<Array<{ device: string; readBps: number; writeBps: number }>>(
    server.diskIoRates,
  );
  const topProcesses = parseJsonField<
    Array<{ pid: number; name: string; cpuPercent: number; memBytes: number }>
  >(server.topProcesses);
  const latest = server.metrics[0];
  const cpuPerCore = parseJsonField<number[]>(latest?.cpuPerCore);

  // UPS (NUT) — only the host wired to the UPS reports upsStatus.
  const upsTokens = (server.upsStatus ?? "").toUpperCase().split(/\s+/).filter(Boolean);
  const upsOnBattery = upsTokens.includes("OB");
  const upsLowBattery = upsTokens.includes("LB");
  const upsLabel = upsLowBattery
    ? "On battery — LOW"
    : upsOnBattery
      ? "On battery"
      : upsTokens.includes("OL")
        ? "On mains"
        : (server.upsStatus ?? "—");
  const upsTone = upsLowBattery
    ? "text-destructive"
    : upsOnBattery
      ? "text-amber-500"
      : "text-success";
  const upsBatterySpark = server.upsSamples
    .slice()
    .reverse()
    .map((s) => s.batteryPercent)
    .filter((v): v is number => v != null);
  // €/kWh for the rough monthly-cost estimate (override via env).
  const powerPrice = Number(process.env.POWER_PRICE_EUR_PER_KWH ?? "0.34") || 0.34;

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

      {/* System snapshot row: uptime, load, swap, processes, failed units,
          network, disk I/O. Hidden entirely if the agent hasn't reported any
          of these yet. */}
      {server.bootAt ||
      loadAvg ||
      networkRates?.length ||
      diskIoRates?.length ||
      latest?.swapPercent != null ||
      latest?.processCount != null ||
      latest?.failedUnits != null ? (
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
            <div className="mb-0.5 text-muted-foreground">Swap</div>
            <div className="tabular-nums font-medium">
              {latest?.swapPercent != null ? `${latest.swapPercent.toFixed(0)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="mb-0.5 text-muted-foreground">Power</div>
            <div className="tabular-nums font-medium">
              {server.powerWatts != null ? (
                <>
                  {server.powerWatts.toFixed(0)} W{" "}
                  <span className="text-muted-foreground">
                    · ~{((server.powerWatts * 24) / 1000).toFixed(1)} kWh/d · €
                    {(((server.powerWatts * 24) / 1000) * 30 * powerPrice).toFixed(0)}/mnd
                  </span>
                </>
              ) : (
                "—"
              )}
            </div>
          </div>
          <div>
            <div className="mb-0.5 text-muted-foreground">Processes</div>
            <div className="tabular-nums font-medium">{latest?.processCount ?? "—"}</div>
          </div>
          <div>
            <div className="mb-0.5 text-muted-foreground">Failed units</div>
            <div
              className={
                latest?.failedUnits && latest.failedUnits > 0
                  ? "tabular-nums font-medium text-destructive"
                  : "tabular-nums font-medium"
              }
            >
              {latest?.failedUnits ?? "—"}
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
          <div className="sm:col-span-2">
            <div className="mb-0.5 text-muted-foreground">Disk I/O</div>
            <div className="space-y-0.5">
              {diskIoRates && diskIoRates.length > 0 ? (
                diskIoRates.map((d) => (
                  <div key={d.device} className="font-medium">
                    <span className="font-mono text-muted-foreground">{d.device}:</span>{" "}
                    r {formatBps(d.readBps)} · w {formatBps(d.writeBps)}
                  </div>
                ))
              ) : (
                "—"
              )}
            </div>
          </div>
        </div>
      ) : null}

      {server.upsStatus ? (
        <div className="mb-6 rounded-xl border border-border bg-card p-3 text-xs">
          <div className="mb-2 text-muted-foreground">
            UPS{server.upsName ? ` · ${server.upsName}` : ""}
          </div>
          <div className="grid gap-2 sm:grid-cols-5">
            <div>
              <div className="mb-0.5 text-muted-foreground">Status</div>
              <div className={`font-medium ${upsTone}`}>{upsLabel}</div>
            </div>
            <div>
              <div className="mb-0.5 text-muted-foreground">Battery</div>
              <div className="tabular-nums font-medium">
                {server.upsBatteryPercent != null ? `${server.upsBatteryPercent.toFixed(0)}%` : "—"}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-muted-foreground">Load</div>
              <div className="tabular-nums font-medium">
                {server.upsLoadPercent != null ? `${server.upsLoadPercent.toFixed(0)}%` : "—"}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-muted-foreground">Runtime</div>
              <div className="tabular-nums font-medium">
                {server.upsRuntimeSec != null ? `${Math.round(server.upsRuntimeSec / 60)} min` : "—"}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-muted-foreground">Input</div>
              <div className="tabular-nums font-medium">
                {server.upsInputVoltage != null ? `${server.upsInputVoltage.toFixed(0)} V` : "—"}
              </div>
            </div>
          </div>
          {upsBatterySpark.length >= 2 ? (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>battery</span>
              <Sparkline values={upsBatterySpark} width={140} height={24} tone="success" />
            </div>
          ) : null}
        </div>
      ) : null}

      {cpuPerCore && cpuPerCore.length > 0 ? (
        <div className="mb-6 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 text-xs text-muted-foreground">
            Per-core CPU ({cpuPerCore.length})
          </div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {cpuPerCore.map((pct, i) => {
              const tone = pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-success";
              return (
                <div key={i} title={`core ${i}: ${pct.toFixed(0)}%`}>
                  <div className="flex items-end justify-between text-[10px] text-muted-foreground">
                    <span className="font-mono">c{i}</span>
                    <span className="tabular-nums">{pct.toFixed(0)}</span>
                  </div>
                  <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full ${tone}`}
                      style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {topProcesses && topProcesses.length > 0 ? (
        <div className="mb-6 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 text-xs text-muted-foreground">Top processes (by CPU)</div>
          <ul className="space-y-1.5 text-xs">
            {topProcesses.map((p) => {
              const tone =
                p.cpuPercent >= 90 ? "text-destructive" : p.cpuPercent >= 50 ? "text-warning" : "";
              return (
                <li key={p.pid} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
                    {p.pid}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium" title={p.name}>
                    {p.name}
                  </span>
                  <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                    {formatBytes(p.memBytes)}
                  </span>
                  <span className={`w-16 shrink-0 text-right tabular-nums font-medium ${tone}`}>
                    {p.cpuPercent.toFixed(1)}%
                  </span>
                </li>
              );
            })}
          </ul>
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

      {server.smartDevices.length > 0 ? (
        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">
            Disk SMART health ({server.smartDevices.length})
          </h2>
          <ul className="space-y-3 text-sm">
            {server.smartDevices.map((dv) => (
              <li key={dv.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{dv.device}</span>
                    <span
                      className={
                        dv.healthy
                          ? "rounded bg-success/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success"
                          : "rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-destructive"
                      }
                    >
                      {dv.healthy ? "passed" : "failed"}
                    </span>
                  </div>
                  {dv.model ? (
                    <div className="truncate text-xs text-muted-foreground">{dv.model}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-x-4 gap-y-0.5 text-right text-xs tabular-nums text-muted-foreground">
                  {dv.tempC != null ? (
                    <span
                      className={
                        dv.tempC >= 60 ? "text-warning" : undefined
                      }
                      title="Temperature"
                    >
                      {dv.tempC}°C
                    </span>
                  ) : null}
                  {dv.wearPercent != null ? (
                    <span
                      className={dv.wearPercent >= 80 ? "text-warning" : undefined}
                      title="Media wear (percentage used)"
                    >
                      {dv.wearPercent}% worn
                    </span>
                  ) : null}
                  {dv.reallocatedSectors != null ? (
                    <span
                      className={dv.reallocatedSectors > 0 ? "text-warning" : undefined}
                      title="Reallocated sectors"
                    >
                      {dv.reallocatedSectors} realloc
                    </span>
                  ) : null}
                  {dv.powerOnHours != null ? (
                    <span title="Power-on hours">{dv.powerOnHours.toLocaleString()} h</span>
                  ) : null}
                </div>
              </li>
            ))}
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
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{c.name}</span>
                      {c.restartCount != null && c.restartCount >= 5 ? (
                        <span
                          title={`${c.restartCount} restarts since creation`}
                          className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-destructive"
                        >
                          ⟳ {c.restartCount}
                        </span>
                      ) : null}
                      {c.updateAvailable ? (
                        <span
                          title="Newer image available on the registry"
                          className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
                        >
                          update
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{c.image}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {c.cpuPercent != null || c.memoryBytes != null ? (
                      <div className="text-right text-[11px] tabular-nums text-muted-foreground">
                        {c.cpuPercent != null ? <div>{c.cpuPercent.toFixed(1)}% cpu</div> : null}
                        {c.memoryBytes != null ? <div>{formatBytes(c.memoryBytes)}</div> : null}
                      </div>
                    ) : null}
                    <StatusBadge status={c.status} />
                  </div>
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
