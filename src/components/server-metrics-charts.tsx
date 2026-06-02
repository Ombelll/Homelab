"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Cpu,
  MemoryStick,
  HardDrive,
  ArrowDownUp,
  Activity,
  Thermometer,
  Layers,
} from "lucide-react";
import { Sparkline } from "@/components/sparkline";
import { ProgressBar } from "@/components/stat-card";
import { formatPercent } from "@/lib/utils";
import { cn } from "@/lib/utils";

type Point = {
  at: string;
  cpu: number;
  memory: number;
  disk: number;
  swap: number | null;
  net: number | null;
  diskIo: number | null;
  temp: number | null;
};

type Range = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";
const RANGES: Range[] = ["15m", "1h", "6h", "24h", "7d", "30d"];

function formatBytesPerSec(bps: number): string {
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

export function ServerMetricsCharts({ serverId }: { serverId: string }) {
  const [range, setRange] = useState<Range>("1h");
  const [data, setData] = useState<Point[]>([]);
  const [source, setSource] = useState<"raw" | "hourly">("raw");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/servers/${serverId}/metrics?range=${range}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`failed (${res.status})`);
        const json = await res.json();
        if (cancelled) return;
        setData(json.metrics ?? []);
        setSource(json.source ?? "raw");
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, range]);

  const latest = data.length > 0 ? data[data.length - 1] : null;

  // A series is only worth a panel if it carried at least one real value over
  // the window (older rows / non-Linux hosts leave these null).
  const has = (key: "swap" | "net" | "diskIo" | "temp") =>
    data.some((p) => p[key] != null);
  // Map nulls to 0 for the sparkline (it wants a dense number[]).
  const series = (key: "swap" | "net" | "diskIo" | "temp") =>
    data.map((p) => p[key] ?? 0);

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-xs transition-colors",
                range === r
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          <span>{data.length} pts · {source}</span>
        </div>
      </div>

      {error ? (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricPanel label="CPU" icon={Cpu} value={latest?.cpu} values={data.map((p) => p.cpu)} percent />
        <MetricPanel
          label="Memory"
          icon={MemoryStick}
          value={latest?.memory}
          values={data.map((p) => p.memory)}
          percent
        />
        <MetricPanel label="Disk" icon={HardDrive} value={latest?.disk} values={data.map((p) => p.disk)} percent />
      </div>

      {has("swap") || has("net") || has("diskIo") || has("temp") ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {has("swap") ? (
            <MetricPanel
              label="Swap"
              icon={Layers}
              value={latest?.swap ?? undefined}
              values={series("swap")}
              percent
            />
          ) : null}
          {has("net") ? (
            <MetricPanel
              label="Network"
              icon={ArrowDownUp}
              value={latest?.net ?? undefined}
              values={series("net")}
              format={formatBytesPerSec}
              tone="primary"
            />
          ) : null}
          {has("diskIo") ? (
            <MetricPanel
              label="Disk I/O"
              icon={Activity}
              value={latest?.diskIo ?? undefined}
              values={series("diskIo")}
              format={formatBytesPerSec}
              tone="primary"
            />
          ) : null}
          {has("temp") ? (
            <MetricPanel
              label="Temp"
              icon={Thermometer}
              value={latest?.temp ?? undefined}
              values={series("temp")}
              format={(v) => `${v.toFixed(0)}°C`}
              tone={
                latest?.temp != null && latest.temp >= 90
                  ? "destructive"
                  : latest?.temp != null && latest.temp >= 75
                    ? "warning"
                    : "success"
              }
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function MetricPanel({
  label,
  icon: Icon,
  value,
  values,
  percent = false,
  format,
  tone: toneOverride,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: number | undefined;
  values: number[];
  // percent panels show a 0-100 progress bar and colour by threshold;
  // non-percent panels (throughput, temperature) show value + sparkline only.
  percent?: boolean;
  format?: (v: number) => string;
  tone?: "primary" | "success" | "warning" | "destructive";
}) {
  const display = value == null ? "—" : format ? format(value) : formatPercent(value, 1);
  const tone =
    toneOverride ??
    (value == null
      ? "primary"
      : value >= 90
        ? "destructive"
        : value >= 75
          ? "warning"
          : "success");
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold tabular-nums">{display}</div>
        <Sparkline values={values} tone={tone} width={180} height={40} />
      </div>
      {percent ? (
        <div className="mt-3">
          <ProgressBar value={value ?? 0} />
        </div>
      ) : null}
    </div>
  );
}
