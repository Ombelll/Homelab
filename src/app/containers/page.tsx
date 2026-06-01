import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ContainerActions } from "@/components/container-actions";

export const dynamic = "force-dynamic";

type Port = { host?: string; container: string; protocol?: string };

async function getContainers() {
  const rows = await prisma.container.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { server: { select: { name: true, hostname: true } } },
  });
  return rows.map((c) => {
    let ports: Port[] = [];
    try {
      const parsed = JSON.parse(c.ports);
      if (Array.isArray(parsed)) ports = parsed;
    } catch {
      ports = [];
    }
    return { ...c, ports };
  });
}

export default async function ContainersPage() {
  const containers = await getContainers();

  return (
    <>
      <PageHeader
        title="Containers"
        description="Docker containers reported by each host's agent."
      />

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <Th>Name</Th>
              <Th>Image</Th>
              <Th>Status</Th>
              <Th>Server</Th>
              <Th>Ports</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {containers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No containers reported yet.
                </td>
              </tr>
            ) : (
              containers.map((c) => (
                <tr key={c.id} className="hover:bg-muted/20">
                  <Td className="font-medium">{c.name}</Td>
                  <Td className="font-mono text-xs text-muted-foreground">{c.image}</Td>
                  <Td><StatusBadge status={c.status} /></Td>
                  <Td>{c.server.name}</Td>
                  <Td>
                    {c.ports.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {c.ports.map((p, i) => (
                          <span
                            key={i}
                            className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                          >
                            {p.host ? `${p.host}:` : ""}
                            {p.container}/{p.protocol ?? "tcp"}
                          </span>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td className="text-right">
                    <ContainerActions id={c.id} name={c.name} status={c.status} />
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Actions enqueue a job for the host agent and wait up to 30 seconds for
        the result. If the agent is offline the UI surfaces a timeout. See{" "}
        <code>AGENTS.md</code> for the protocol.
      </p>
    </>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-3 text-left font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}
