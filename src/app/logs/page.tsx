import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/page-header";
import { formatRelativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

export default async function LogsPage({
  searchParams,
}: {
  searchParams: { q?: string; server?: string };
}) {
  const q = (searchParams.q ?? "").trim();
  const serverId = (searchParams.server ?? "").trim();

  const [servers, logs] = await Promise.all([
    prisma.server.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.logEntry.findMany({
      where: {
        ...(serverId ? { serverId } : {}),
        ...(q ? { message: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { at: "desc" },
      take: PAGE_SIZE,
      include: { server: { select: { name: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Logs"
        description="Warn/error lines shipped from the host journal and container logs. Searchable; pruned by the retention job."
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Search</span>
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="message contains…"
            className="w-64 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Host</span>
          <select
            name="server"
            defaultValue={serverId}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All hosts</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Search
        </button>
        {(q || serverId) && (
          <a href="/logs" className="px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            Clear
          </a>
        )}
      </form>

      {logs.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {q || serverId ? "No matching log lines." : "No logs shipped yet (agents ship warn/error lines every 5 min)."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Time</th>
                <th className="px-3 py-2 text-left font-medium">Host</th>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-left font-medium">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((l) => (
                <tr key={l.id} className="align-top hover:bg-muted/20">
                  <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                    {formatRelativeTime(l.at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-xs">{l.server.name}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-muted-foreground">
                    {l.source}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Showing {logs.length}{logs.length === PAGE_SIZE ? ` (most recent ${PAGE_SIZE})` : ""}.
          </div>
        </div>
      )}
    </>
  );
}
