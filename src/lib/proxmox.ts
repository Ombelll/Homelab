import https from "node:https";

/**
 * Minimal read-only Proxmox VE API client. Talks to the cluster resources
 * endpoint with an API token (PVEAuditor role is enough) and returns the nodes
 * and guests (QEMU VMs + LXC containers) it finds.
 *
 * Config is read from env on the dashboard host (CT 101):
 *   PROXMOX_API_URL      e.g. https://192.168.1.10:8006
 *   PROXMOX_TOKEN_ID     e.g. monitor@pam!dashboard
 *   PROXMOX_TOKEN_SECRET the token's secret (uuid)
 *   PROXMOX_TLS_INSECURE "0" to enforce cert validation (default: allow the
 *                        node's self-signed cert, which is the homelab norm)
 *
 * Read-only by design: this module never POSTs. Lifecycle actions are a
 * deliberate non-goal of this version.
 */

export type ProxmoxConfig = { url: string; tokenId: string; secret: string; insecure: boolean };

export type ProxmoxNodeStat = {
  node: string;
  status: string; // "online" | "offline"
  cpu: number | null; // fraction 0..1
  maxCpu: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  uptimeSec: number | null;
  level: string | null;
};

export type ProxmoxGuestStat = {
  vmid: number;
  type: string; // "qemu" | "lxc"
  name: string;
  node: string;
  status: string; // "running" | "stopped" | ...
  cpu: number | null;
  maxCpu: number | null;
  memUsedMb: number | null;
  maxMemMb: number | null;
  diskUsedMb: number | null;
  maxDiskMb: number | null;
  uptimeSec: number | null;
  template: boolean;
  tags: string | null;
};

export type ProxmoxData = { nodes: ProxmoxNodeStat[]; guests: ProxmoxGuestStat[] };

/** Resolve the env config, or null when the integration isn't configured. */
export function proxmoxConfig(): ProxmoxConfig | null {
  const url = process.env.PROXMOX_API_URL?.trim().replace(/\/+$/, "");
  const tokenId = process.env.PROXMOX_TOKEN_ID?.trim();
  const secret = process.env.PROXMOX_TOKEN_SECRET?.trim();
  if (!url || !tokenId || !secret) return null;
  return { url, tokenId, secret, insecure: process.env.PROXMOX_TLS_INSECURE !== "0" };
}

export function proxmoxConfigured(): boolean {
  return proxmoxConfig() != null;
}

// bytes → whole MiB (the schema stores memory/disk in MiB to dodge BigInt).
const mb = (bytes: unknown): number | null =>
  typeof bytes === "number" && Number.isFinite(bytes) ? Math.round(bytes / 1048576) : null;

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** GET `/api2/json{path}` and return the parsed `.data`. Throws on failure. */
function pveGet(cfg: ProxmoxConfig, path: string): Promise<unknown> {
  const target = new URL(`${cfg.url}/api2/json${path}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: "GET",
        headers: { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.secret}` },
        // Homelab Proxmox nodes use a self-signed cert by default. Opt out with
        // PROXMOX_TLS_INSECURE=0 once a trusted cert is installed.
        rejectUnauthorized: !cfg.insecure,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`proxmox ${path} → HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve((JSON.parse(body) as { data?: unknown }).data);
          } catch {
            reject(new Error(`proxmox ${path}: invalid JSON`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`proxmox ${path}: timeout`)));
    req.end();
  });
}

/**
 * Split a raw /cluster/resources array into nodes + guests. Pure (no I/O) so it
 * can be unit-tested against recorded Proxmox payloads. Unknown resource types
 * (storage, sdn, …) are ignored; guests without a usable vmid are dropped.
 */
export function partitionResources(raw: unknown): ProxmoxData {
  if (!Array.isArray(raw)) throw new Error("proxmox: unexpected resources payload");

  const nodes: ProxmoxNodeStat[] = [];
  const guests: ProxmoxGuestStat[] = [];

  for (const r of raw as Record<string, unknown>[]) {
    if (r.type === "node") {
      nodes.push({
        node: String(r.node ?? ""),
        status: String(r.status ?? "unknown"),
        cpu: numOrNull(r.cpu),
        maxCpu: numOrNull(r.maxcpu),
        memUsedMb: mb(r.mem),
        memTotalMb: mb(r.maxmem),
        uptimeSec: numOrNull(r.uptime),
        level: typeof r.level === "string" ? r.level : null,
      });
    } else if (r.type === "qemu" || r.type === "lxc") {
      guests.push({
        vmid: Number(r.vmid),
        type: String(r.type),
        name: String(r.name ?? `vm-${r.vmid}`),
        node: String(r.node ?? ""),
        status: String(r.status ?? "unknown"),
        cpu: numOrNull(r.cpu),
        maxCpu: numOrNull(r.maxcpu),
        memUsedMb: mb(r.mem),
        maxMemMb: mb(r.maxmem),
        diskUsedMb: mb(r.disk),
        maxDiskMb: mb(r.maxdisk),
        uptimeSec: numOrNull(r.uptime),
        template: r.template === 1 || r.template === true,
        tags: typeof r.tags === "string" && r.tags.length > 0 ? r.tags : null,
      });
    }
  }

  return { nodes, guests: guests.filter((g) => Number.isFinite(g.vmid)) };
}

/**
 * Poll the cluster resources endpoint once and split it into nodes + guests.
 * Returns null when the integration isn't configured. A single call to
 * /cluster/resources yields every node and guest with their live metrics, so we
 * don't fan out per-node.
 */
export async function collectProxmox(): Promise<ProxmoxData | null> {
  const cfg = proxmoxConfig();
  if (!cfg) return null;
  return partitionResources(await pveGet(cfg, "/cluster/resources"));
}
