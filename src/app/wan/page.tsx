import { PageHeader } from "@/components/page-header";
import { Sparkline } from "@/components/sparkline";
import { formatRelativeTime } from "@/lib/utils";
import { Download, Upload, Gauge } from "lucide-react";

export const dynamic = "force-dynamic";

type Result = { at: string; downloadMbps: number; uploadMbps: number; pingMs: number; failed: boolean };

type Fetched =
  | { ok: true; results: Result[] }
  | { ok: false; reason: "unconfigured" | "error"; detail?: string };

// speedtest-tracker (alexjustesen) v1 API. download/upload are bits/s, ping ms.
// Reachable from the dashboard container by name on the shared `proxy` network.
async function getResults(): Promise<Fetched> {
  const base = (process.env.SPEEDTEST_URL || "http://speedtest-tracker").replace(/\/+$/, "");
  const token = process.env.SPEEDTEST_API_TOKEN;
  if (!token) return { ok: false, reason: "unconfigured" };
  try {
    const res = await fetch(`${base}/api/v1/results?per_page=90`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: "error", detail: `speedtest API returned ${res.status}` };
    const json = await res.json();
    const rows: Record<string, unknown>[] = Array.isArray(json?.data) ? json.data : [];
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const results: Result[] = rows
      .map((r) => {
        const d = (r.data as Record<string, unknown>) ?? {};
        const downBits = num(r.download ?? d.download);
        const upBits = num(r.upload ?? d.upload);
        return {
          at: String(r.created_at ?? r.updated_at ?? ""),
          downloadMbps: downBits / 1e6,
          uploadMbps: upBits / 1e6,
          pingMs: num(r.ping ?? d.ping),
          failed: Boolean(r.failed),
        };
      })
      .filter((r) => r.at);
    results.reverse(); // API is newest-first; chronological for the chart
    return { ok: true, results };
  } catch (e) {
    return { ok: false, reason: "error", detail: (e as Error).message };
  }
}

function fmt(n: number | undefined, unit: string, dp = 0): string {
  if (n == null || n <= 0) return "—";
  return `${n.toFixed(n < 10 ? Math.max(dp, 1) : dp)} ${unit}`;
}

export default async function WanPage() {
  const data = await getResults();

  return (
    <>
      <PageHeader
        title="WAN"
        description="Internet download, upload and latency over time — measured by speedtest-tracker."
      />

      {!data.ok ? (
        <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground">
          {data.reason === "unconfigured" ? (
            <>
              <p className="mb-2 font-medium text-foreground">Speedtest API not configured yet.</p>
              <p className="mb-3">
                Create an API token in speedtest-tracker (<code>speed.lan</code> → your profile →
                <strong> API Tokens</strong>), then set it on the dashboard host and recreate the
                dashboard:
              </p>
              <pre className="overflow-x-auto rounded-md border border-border bg-background/60 p-3 text-xs">
{`# in /opt/Homelab/.env
SPEEDTEST_API_TOKEN=<token from speedtest-tracker>
# then, from /opt/Homelab:
docker compose --env-file .env -f docker-compose.yml -f deploy/docker-compose.labels.yml up -d`}
              </pre>
              <p className="mt-3">
                The dashboard reaches speedtest-tracker over the internal <code>proxy</code> network
                (<code>http://speedtest-tracker</code>) — no DNS rewrite needed.
              </p>
            </>
          ) : (
            <>
              <p className="mb-2 font-medium text-foreground">Couldn&apos;t reach speedtest-tracker.</p>
              <p className="font-mono text-xs">{data.detail}</p>
              <p className="mt-3">
                Check the token is valid and that the <code>speedtest-tracker</code> container is up
                on the <code>proxy</code> network.
              </p>
            </>
          )}
        </div>
      ) : data.results.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">No speed tests yet.</p>
          <p className="mt-2">
            Run one in speedtest-tracker (<code>speed.lan</code>) or wait for the scheduled hourly
            test, then refresh.
          </p>
        </div>
      ) : (
        <WanContent results={data.results} />
      )}
    </>
  );
}

function WanContent({ results }: { results: Result[] }) {
  const ok = results.filter((r) => !r.failed);
  const latest = ok.length > 0 ? ok[ok.length - 1] : undefined;

  const down = ok.map((r) => r.downloadMbps);
  const up = ok.map((r) => r.uploadMbps);
  const ping = ok.map((r) => r.pingMs);
  // Download + upload share a Y scale so the two charts are visually comparable.
  const speedMax = Math.max(1, ...down, ...up);
  const pingMax = Math.max(1, ...ping);
  const norm = (arr: number[], max: number) => arr.map((v) => (v / max) * 100);

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <SpeedPanel
          label="Download"
          icon={Download}
          value={fmt(latest?.downloadMbps, "Mbps")}
          sub={`avg ${fmt(avg(down), "Mbps")}`}
          spark={norm(down, speedMax)}
          tone="success"
        />
        <SpeedPanel
          label="Upload"
          icon={Upload}
          value={fmt(latest?.uploadMbps, "Mbps")}
          sub={`avg ${fmt(avg(up), "Mbps")}`}
          spark={norm(up, speedMax)}
          tone="primary"
        />
        <SpeedPanel
          label="Ping"
          icon={Gauge}
          value={fmt(latest?.pingMs, "ms", 1)}
          sub={`avg ${fmt(avg(ping), "ms", 1)}`}
          spark={norm(ping, pingMax)}
          tone={latest && latest.pingMs >= 50 ? "warning" : "success"}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border bg-muted/30 px-4 py-2.5 text-sm font-semibold">
          Recent tests
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">When</th>
              <th className="px-4 py-2 text-right font-medium">↓ Download</th>
              <th className="px-4 py-2 text-right font-medium">↑ Upload</th>
              <th className="px-4 py-2 text-right font-medium">Ping</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {results
              .slice()
              .reverse()
              .slice(0, 20)
              .map((r, i) => (
                <tr key={i} className="hover:bg-muted/20">
                  <td className="px-4 py-2 text-muted-foreground">{formatRelativeTime(new Date(r.at))}</td>
                  {r.failed ? (
                    <td colSpan={3} className="px-4 py-2 text-right text-destructive">
                      test failed
                    </td>
                  ) : (
                    <>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(r.downloadMbps, "Mbps")}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(r.uploadMbps, "Mbps")}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {fmt(r.pingMs, "ms", 1)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SpeedPanel({
  label,
  icon: Icon,
  value,
  sub,
  spark,
  tone,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  sub: string;
  spark: number[];
  tone: "primary" | "success" | "warning" | "destructive";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          <div className="text-xs text-muted-foreground">{sub}</div>
        </div>
        <Sparkline values={spark} tone={tone} width={170} height={40} />
      </div>
    </div>
  );
}
