"use client";

import { useEffect, useState } from "react";
import { Loader2, Cpu, MemoryStick, HardDrive } from "lucide-react";
import { Sparkline } from "@/components/sparkline";
import { ProgressBar } from "@/components/stat-card";
import { formatPercent } from "@/lib/utils";
import { cn } from "@/lib/utils";

type Point = {
  at: string;
  cpu: number;
  memory: number;
  disk: number;
};

type Range = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";
const RANGES: Range[] = ["15m", "1h", "6h", "24h", "7d", "30d"];

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
        <MetricPanel
          label="CPU"
          icon={Cpu}
          value={latest?.cpu}
          values={data.map((p) => p.cpu)}
        />
        <MetricPanel
          label="Memory"
          icon={MemoryStick}
          value={latest?.memory}
          values={data.map((p) => p.memory)}
        />
        <MetricPanel
          label="Disk"
          icon={HardDrive}
          value={latest?.disk}
          values={data.map((p) => p.disk)}
        />
      </div>
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
  const tone =
    value == null
      ? "primary"
      : value >= 90
      ? "destructive"
      : value >= 75
      ? "warning"
      : "success";
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
      <div className="mt-3">
        <ProgressBar value={value ?? 0} />
      </div>
    </div>
  );
}
