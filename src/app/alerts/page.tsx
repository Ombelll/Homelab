import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const alerts = await prisma.alert.findMany({
    orderBy: [{ resolved: "asc" }, { createdAt: "desc" }],
    take: 100,
    include: { server: { select: { name: true } } },
  });

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Recent issues raised by metrics, agents, or future health checks."
      />

      {alerts.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No alerts on file.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <Th>Severity</Th>
                <Th>Type</Th>
                <Th>Server</Th>
                <Th>Message</Th>
                <Th>Status</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {alerts.map((a) => (
                <tr key={a.id} className="hover:bg-muted/20">
                  <Td><StatusBadge status={a.severity} /></Td>
                  <Td className="font-mono text-xs">{a.type}</Td>
                  <Td>{a.server?.name ?? <span className="text-muted-foreground">system</span>}</Td>
                  <Td>{a.message}</Td>
                  <Td>
                    <StatusBadge status={a.resolved ? "online" : "warning"} />
                    <span className="ml-1 text-xs text-muted-foreground">
                      {a.resolved ? "resolved" : "open"}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{formatRelativeTime(a.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left font-medium">{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}
