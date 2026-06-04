import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Public, read-only status page at /status/<token>. No login required — access
 * is gated by STATUS_PAGE_TOKEN (a capability URL, like a healthchecks ping
 * URL). Deliberately exposes only names + up/down, never IPs/OS/metrics.
 *
 * Disabled (404) unless STATUS_PAGE_TOKEN is set. Pair with Tailscale Funnel
 * if you want it reachable from outside the tailnet.
 */
export default async function StatusPage({ params }: { params: { token: string } }) {
  const expected = process.env.STATUS_PAGE_TOKEN?.trim();
  if (!expected || params.token !== expected) notFound();

  const [servers, checks] = await Promise.all([
    prisma.server.findMany({ orderBy: { name: "asc" }, select: { name: true, status: true } }),
    prisma.healthCheck.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
      select: { name: true, lastStatus: true },
    }),
  ]);

  const serversOk = servers.every((s) => s.status === "online");
  const checksOk = checks.every((c) => c.lastStatus !== "down");
  const allOk = serversOk && checksOk;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">Homelab status</h1>
      <div
        className={`mt-3 rounded-lg border px-4 py-3 text-sm font-medium ${
          allOk
            ? "border-success/30 bg-success/10 text-success"
            : "border-destructive/30 bg-destructive/10 text-destructive"
        }`}
      >
        {allOk ? "✓ All systems operational" : "⚠ Some systems are degraded"}
      </div>

      <Section title="Hosts">
        {servers.map((s) => (
          <Row key={s.name} name={s.name} ok={s.status === "online"} label={s.status} />
        ))}
      </Section>

      {checks.length > 0 ? (
        <Section title="Services">
          {checks.map((c) => (
            <Row key={c.name} name={c.name} ok={c.lastStatus !== "down"} label={c.lastStatus ?? "unknown"} />
          ))}
        </Section>
      ) : null}

      <p className="mt-8 text-xs text-muted-foreground">
        Updated {new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · Homelab Control Center
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">{children}</div>
    </div>
  );
}

function Row({ name, ok, label }: { name: string; ok: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm">
      <span>{name}</span>
      <span className="inline-flex items-center gap-2">
        <span className="capitalize text-muted-foreground">{label}</span>
        <span className={`h-2 w-2 rounded-full ${ok ? "bg-success" : "bg-destructive"}`} />
      </span>
    </div>
  );
}
