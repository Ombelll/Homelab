import { PageHeader } from "@/components/page-header";
import { ExternalLink } from "lucide-react";

export const dynamic = "force-dynamic";

// Curated launcher. Edit this list to add/rename services. *.lan names route
// through Traefik (need the matching AdGuard DNS rewrite → 192.168.1.21);
// Proxmox/PBS use their host IPs directly.
type App = { name: string; url: string; desc: string };
const GROUPS: { title: string; items: App[] }[] = [
  {
    title: "Infrastructuur",
    items: [
      { name: "Proxmox-01", url: "https://192.168.1.10:8006", desc: "Node 1 — hypervisor (cluster)" },
      { name: "Proxmox-02", url: "https://192.168.1.11:8006", desc: "Node 2 — hypervisor (cluster)" },
      { name: "Proxmox Backup Server", url: "https://192.168.1.11:8007", desc: "Off-box backups (node 2)" },
      { name: "AdGuard Home", url: "http://adguard.lan", desc: "Netwerk-DNS + ad-blocking" },
      { name: "Homepage", url: "http://home.lan", desc: "Start-/linkpagina" },
      { name: "Dockge", url: "http://dockge.lan", desc: "Docker-compose stack-manager" },
      { name: "authentik (SSO)", url: "http://auth.lan", desc: "Single sign-on / identity provider" },
    ],
  },
  {
    title: "Media",
    items: [
      { name: "Jellyfin", url: "http://jellyfin.lan", desc: "Films & series streamen" },
      { name: "Jellyseerr", url: "http://requests.lan", desc: "Media aanvragen" },
      { name: "Navidrome", url: "http://music.lan", desc: "Muziek streamen" },
      { name: "Kavita", url: "http://books.lan", desc: "E-books / strips / manga" },
    ],
  },
  {
    title: "Downloads (*arr)",
    items: [
      { name: "Prowlarr", url: "http://prowlarr.lan", desc: "Indexer-beheer" },
      { name: "Sonarr", url: "http://sonarr.lan", desc: "Series" },
      { name: "Radarr", url: "http://radarr.lan", desc: "Films" },
      { name: "Bazarr", url: "http://bazarr.lan", desc: "Ondertitels" },
      { name: "qBittorrent", url: "http://qb.lan", desc: "Downloadclient" },
    ],
  },
  {
    title: "Productiviteit",
    items: [
      { name: "Nextcloud", url: "http://nextcloud.lan", desc: "Bestanden, agenda, contacten" },
      { name: "Immich", url: "http://immich.lan", desc: "Foto's & video's" },
      { name: "Paperless-ngx", url: "http://paperless.lan", desc: "Documenten scannen/archiveren" },
      { name: "Vaultwarden", url: "http://vault.lan", desc: "Wachtwoordkluis (via HTTPS/tailnet)" },
      { name: "Forgejo", url: "http://git.lan", desc: "Git-hosting" },
      { name: "n8n", url: "http://n8n.lan", desc: "Workflow-automatisering" },
    ],
  },
  {
    title: "Tools",
    items: [
      { name: "SearXNG", url: "http://search.lan", desc: "Privé-zoekmachine" },
      { name: "Stirling-PDF", url: "http://pdf.lan", desc: "PDF-gereedschapskist" },
      { name: "IT-Tools", url: "http://tools.lan", desc: "Dev/sysadmin-utilities" },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { name: "Uptime-Kuma", url: "http://uptime.lan", desc: "Uptime-monitoring" },
      { name: "speedtest-tracker", url: "http://speed.lan", desc: "Internetsnelheid over tijd" },
    ],
  },
];

export default async function AppsPage() {
  return (
    <>
      <PageHeader
        title="Apps"
        description="Snelkoppelingen naar al je dashboards. *.lan-namen lopen via Traefik (AdGuard-rewrite naar 192.168.1.21); Proxmox/PBS via IP."
      />
      <div className="space-y-6">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {group.items.map((app) => (
                <a
                  key={app.name}
                  href={app.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{app.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{app.desc}</div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
                      {app.url.replace(/^https?:\/\//, "")}
                    </div>
                  </div>
                  <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
