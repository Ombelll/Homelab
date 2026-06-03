import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { ServicesPanel } from "@/components/services-panel";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const [user, checks] = await Promise.all([
    getCurrentUser(),
    prisma.healthCheck.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
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
        }))}
        canEdit={canEdit}
      />
    </>
  );
}
