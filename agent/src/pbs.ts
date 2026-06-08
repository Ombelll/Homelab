import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type PbsDatastore = {
  name: string;
  totalBytes?: number;
  usedBytes?: number;
  snapshots: number;
  lastBackupAt?: string; // ISO; newest snapshot across all guests
};
export type PbsInfo = { datastores: PbsDatastore[] };

/**
 * Proxmox Backup Server datastore status, or undefined when this host isn't a
 * PBS server (no proxmox-backup-manager). Usage comes from `df` on each
 * datastore path; snapshot count + last-backup time are derived from the
 * ct/<id>/<ts> + vm/<id>/<ts> directory tree (avoids needing an API token).
 */
export async function getPbsInfo(): Promise<PbsInfo | undefined> {
  if (process.platform !== "linux") return undefined;

  let list: { name: string; path?: string }[];
  try {
    const { stdout } = await execAsync(
      "proxmox-backup-manager datastore list --output-format json",
      { timeout: 5_000 },
    );
    list = JSON.parse(stdout);
  } catch {
    return undefined; // not a PBS host
  }
  if (!Array.isArray(list) || list.length === 0) return undefined;

  const datastores: PbsDatastore[] = [];
  for (const ds of list) {
    const entry: PbsDatastore = { name: ds.name, snapshots: 0 };
    const path = ds.path;
    if (path) {
      try {
        const { stdout } = await execAsync(
          `df -B1 --output=size,used '${path.replace(/'/g, "")}' | tail -1`,
          { timeout: 5_000 },
        );
        const [size, used] = stdout.trim().split(/\s+/).map(Number);
        if (Number.isFinite(size)) entry.totalBytes = size;
        if (Number.isFinite(used)) entry.usedBytes = used;
      } catch {
        /* df failed — leave usage undefined */
      }
      for (const type of ["ct", "vm"]) {
        let ids: string[];
        try {
          ids = await fs.readdir(`${path}/${type}`);
        } catch {
          continue; // no guests of this type
        }
        for (const id of ids) {
          let snaps: string[];
          try {
            snaps = await fs.readdir(`${path}/${type}/${id}`);
          } catch {
            continue;
          }
          for (const s of snaps) {
            try {
              const st = await fs.stat(`${path}/${type}/${id}/${s}`);
              if (!st.isDirectory()) continue;
              entry.snapshots++;
              const iso = st.mtime.toISOString();
              if (!entry.lastBackupAt || iso > entry.lastBackupAt) entry.lastBackupAt = iso;
            } catch {
              /* vanished between readdir and stat */
            }
          }
        }
      }
    }
    datastores.push(entry);
  }

  return { datastores };
}
