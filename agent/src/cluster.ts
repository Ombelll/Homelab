import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ClusterNode = { name: string; online: boolean; local: boolean };
export type ClusterInfo = {
  name: string;
  quorate: boolean;
  nodes: ClusterNode[];
  expectedVotes?: number;
  totalVotes?: number;
  quorumNeeded?: number;
  qdevice?: boolean;
};

/**
 * Proxmox cluster status, or undefined when this host isn't part of a cluster
 * (or isn't a Proxmox host). Primary source is /etc/pve/.members — JSON that
 * pmxcfs maintains with the cluster name, quorate flag and per-node online
 * state. Vote totals + QDevice presence are a best-effort parse of
 * `corosync-quorumtool -s` (omitted if that tool isn't available).
 */
export async function getClusterInfo(): Promise<ClusterInfo | undefined> {
  if (process.platform !== "linux") return undefined;

  let members: {
    nodename?: string;
    cluster?: { name?: string; quorate?: number };
    nodelist?: Record<string, { online?: number }>;
  };
  try {
    members = JSON.parse(await fs.readFile("/etc/pve/.members", "utf8"));
  } catch {
    return undefined; // not a Proxmox host, or pmxcfs not mounted
  }

  const cluster = members.cluster;
  if (!cluster || !cluster.name) return undefined; // standalone node — not clustered

  const self = members.nodename;
  const nodelist = members.nodelist ?? {};
  const nodes: ClusterNode[] = Object.entries(nodelist)
    .map(([name, info]) => ({
      name,
      online: info?.online === 1,
      local: name === self,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const info: ClusterInfo = {
    name: String(cluster.name),
    quorate: cluster.quorate === 1,
    nodes,
  };

  try {
    const { stdout } = await execAsync("corosync-quorumtool -s", { timeout: 5_000 });
    const num = (re: RegExp): number | undefined => {
      const m = re.exec(stdout);
      return m ? Number(m[1]) : undefined;
    };
    info.expectedVotes = num(/Expected votes:\s+(\d+)/);
    info.totalVotes = num(/Total votes:\s+(\d+)/);
    info.quorumNeeded = num(/Quorum:\s+(\d+)/);
    // The "Qdevice" column/row only appears once a QDevice is configured.
    info.qdevice = /Qdevice/i.test(stdout);
  } catch {
    // corosync-quorumtool missing or failed — vote details stay undefined.
  }

  return info;
}
