import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { AgentKeysPanel } from "@/components/agent-keys-panel";
import { InvitesPanel } from "@/components/invites-panel";
import { NotificationsPanel } from "@/components/notifications-panel";
import { UsersPanel } from "@/components/users-panel";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  // Viewers can navigate everywhere else but the Settings page is admin-only.
  // We surface 'access denied' rather than redirecting so the user sees why.
  if (user && user.role !== "admin") {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-6 text-sm">
          <div className="mb-1 font-semibold">Admin access required</div>
          <div className="text-muted-foreground">
            Your account has the <code>viewer</code> role. Ask an admin to
            upgrade you if you need to manage agents, invites, or
            notifications.
          </div>
        </div>
      </>
    );
  }
  // Middleware should have redirected unauthenticated users already; defensive
  // fallback just in case.
  if (!user) redirect("/login");
  return <AdminSettings />;
}

function AdminSettings() {
  const hasAgentKey = Boolean(process.env.AGENT_API_KEY && process.env.AGENT_API_KEY.length > 16);
  const dbUrl = process.env.DATABASE_URL ?? "(unset)";
  const safeDb = dbUrl.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");

  return (
    <>
      <PageHeader
        title="Settings"
        description="Runtime configuration. Most options live in environment variables."
      />

      <div className="space-y-4">
        <UsersPanel />

        <Card title="Authentication">
          <Row label="AGENT_API_KEY">
            {hasAgentKey ? (
              <span className="text-success">configured (≥16 chars)</span>
            ) : (
              <span className="text-warning">missing or too short — set it in your .env</span>
            )}
          </Row>
          <p className="mt-2 text-xs text-muted-foreground">
            Agents must send this in the <code>X-Agent-Key</code> header.
          </p>
        </Card>

        <Card title="Database">
          <Row label="DATABASE_URL">
            <span className="font-mono text-xs">{safeDb}</span>
          </Row>
          <p className="mt-2 text-xs text-muted-foreground">
            SQLite is the default. Swap the provider in <code>prisma/schema.prisma</code> for Postgres later.
          </p>
        </Card>

        <NotificationsPanel />

        <AgentKeysPanel />

        <InvitesPanel />

        <Card title="Hardening checklist">
          <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
            <li>Run the dashboard only behind a VPN (Tailscale / WireGuard) or trusted LAN.</li>
            <li>Use a long, random <code>AGENT_API_KEY</code> — rotate it periodically.</li>
            <li>Do NOT mount <code>/var/run/docker.sock</code> into the dashboard container.</li>
            <li>Front the dashboard with TLS (Caddy / Traefik / nginx) before exposing it.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
