import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { ServicesPanel } from "@/components/services-panel";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [user, checks, totals, oks] = await Promise.all([
    getCurrentUser(),
    prisma.healthCheck.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.healthCheckResult.groupBy({ by: ["checkId"], where: { at: { gte: since } }, _count: { _all: true } }),
    prisma.healthCheckResult.groupBy({
      by: ["checkId"],
      where: { at: { gte: since }, ok: true },
      _count: { _all: true },
    }),
  ]);
  const totalBy = new Map(totals.map((t) => [t.checkId, t._count._all]));
  const okBy = new Map(oks.map((t) => [t.checkId, t._count._all]));
  const uptime24 = (id: string): number | null => {
    const total = totalBy.get(id) ?? 0;
    if (total === 0) return null;
    return Math.round(((okBy.get(id) ?? 0) / total) * 1000) / 10;
  };
  const canEdit = user?.role === "admin";
  return (
    <>
      <PageHeader
        title="Services"
        description="External service-level health probes — HTTP, TCP, ping, and TLS-cert expiry. The runner picks up due checks every minute."
      />
      <ServicesPanel
        initialChecks={checks.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          target: c.target,
          intervalSeconds: c.intervalSeconds,
          timeoutMs: c.timeoutMs,
          expectedStatus: c.expectedStatus,
          enabled: c.enabled,
          lastStatus: c.lastStatus,
          lastLatencyMs: c.lastLatencyMs,
          lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
          lastError: c.lastError,
          certExpiresAt: c.certExpiresAt?.toISOString() ?? null,
          uptime24: uptime24(c.id),
        }))}
        canEdit={canEdit}
      />
    </>
  );
}
