import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ProgressBar } from "@/components/stat-card";
import { formatPercent, formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getServers() {
  return prisma.server.findMany({
    orderBy: { name: "asc" },
    include: { metrics: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
}

export default async function ServersPage() {
  const servers = await getServers();

  return (
    <>
      <PageHeader
        title="Servers"
        description="Every host that has checked in via an agent."
      />

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <Th>Name</Th>
              <Th>Hostname / IP</Th>
              <Th>OS</Th>
              <Th>Status</Th>
              <Th>CPU</Th>
              <Th>Memory</Th>
              <Th>Disk</Th>
              <Th>Last seen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {servers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No servers yet. Run the agent on a host to register it.
                </td>
              </tr>
            ) : (
              servers.map((s) => {
                const m = s.metrics[0];
                return (
                  <tr key={s.id} className="hover:bg-muted/20">
                    <Td className="font-medium">
                      <Link href={`/servers/${s.id}`} className="hover:text-primary hover:underline">
                        {s.name}
                      </Link>
                    </Td>
                    <Td>
                      <div>{s.hostname}</div>
                      <div className="text-xs text-muted-foreground">{s.ipAddress ?? "—"}</div>
                    </Td>
                    <Td className="text-muted-foreground">{s.os ?? "—"}</Td>
                    <Td><StatusBadge status={s.status} /></Td>
                    <MetricCell value={m?.cpuPercent} />
                    <MetricCell value={m?.memoryPercent} />
                    <MetricCell value={m?.diskPercent} />
                    <Td className="text-muted-foreground">{formatRelativeTime(s.lastSeenAt)}</Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left font-medium">{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}

function MetricCell({ value }: { value: number | undefined }) {
  if (value == null) {
    return <Td className="text-muted-foreground">—</Td>;
  }
  return (
    <Td>
      <div className="tabular-nums">{formatPercent(value, 1)}</div>
      <div className="mt-1 w-24"><ProgressBar value={value} /></div>
    </Td>
  );
}
