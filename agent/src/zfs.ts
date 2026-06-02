import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ZfsPoolReading = {
  name: string;
  health: string;
  totalBytes: number;
  usedBytes: number;
  lastScrubAt?: string;
};

/**
 * Snapshot of every ZFS pool on this host. Returns [] when zpool isn't
 * installed (most non-storage Linux boxes, all macOS-without-OpenZFS,
 * Windows). Failures during parsing are logged but never thrown.
 *
 * We use the standard one-line zpool list output. Health comes from a
 * separate column; if the pool is degraded but reads/writes still work,
 * the dashboard sees it through `health` regardless of usage %.
 */
export async function getZfsPools(): Promise<ZfsPoolReading[]> {
  if (!(await hasZpool())) return [];
  try {
    // -H: no header. -p: parseable (bytes, not KB/MB). -o: explicit columns.
    const { stdout } = await execAsync(
      "zpool list -H -p -o name,size,alloc,health",
      { timeout: 10_000 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseLine)
      .filter((p): p is ZfsPoolReading => p !== null);
  } catch (err) {
    console.warn("[agent] zpool read failed:", (err as Error).message);
    return [];
  }
}

// Whether zpool exists doesn't change while the agent runs, so probe once and
// cache it — avoids spawning a `command -v` subprocess on every tick (every
// 30s) on every host, the vast majority of which have no ZFS at all.
let zpoolAvailable: boolean | undefined;

async function hasZpool(): Promise<boolean> {
  if (zpoolAvailable !== undefined) return zpoolAvailable;
  if (process.platform !== "linux" && process.platform !== "darwin") {
    zpoolAvailable = false;
    return false;
  }
  try {
    await execAsync("command -v zpool", { timeout: 5_000 });
    zpoolAvailable = true;
  } catch {
    zpoolAvailable = false;
  }
  return zpoolAvailable;
}

export function parseLine(line: string): ZfsPoolReading | null {
  // Columns: name, size (bytes), alloc (bytes), health
  const parts = line.split(/\s+/);
  if (parts.length < 4) return null;
  const [name, sizeStr, allocStr, health] = parts;
  const totalBytes = Number(sizeStr);
  const usedBytes = Number(allocStr);
  if (!name || !Number.isFinite(totalBytes) || !Number.isFinite(usedBytes)) return null;
  return { name, health, totalBytes, usedBytes };
}
