import { promises as fs } from "node:fs";

export type DiskIoRate = { device: string; readBps: number; writeBps: number };

type Snapshot = { read: number; write: number; at: number };

// Per-device counters from the previous tick, to compute a delta. Mirrors
// network.ts. Sectors in /proc/diskstats are always 512 bytes.
const prevSnapshot = new Map<string, Snapshot>();
const SECTOR_BYTES = 512;

/**
 * Best-effort per-device disk throughput (bytes/sec) from /proc/diskstats.
 * Linux only. First tick returns [] (needs two samples for a delta). We keep
 * whole devices (sda, nvme0n1, vda) and drop partitions and virtual devices.
 */
export async function getDiskIoRates(): Promise<DiskIoRate[]> {
  if (process.platform !== "linux") return [];
  let content: string;
  try {
    content = await fs.readFile("/proc/diskstats", "utf8");
  } catch {
    return [];
  }

  const now = Date.now();
  const out: DiskIoRate[] = [];

  for (const line of content.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const device = f[2];
    if (shouldSkip(device)) continue;

    // Fields (1-indexed): 6 = sectors read, 10 = sectors written.
    const readSectors = Number(f[5]);
    const writeSectors = Number(f[9]);
    if (!Number.isFinite(readSectors) || !Number.isFinite(writeSectors)) continue;

    const prev = prevSnapshot.get(device);
    prevSnapshot.set(device, { read: readSectors, write: writeSectors, at: now });
    if (!prev) continue;

    const sec = (now - prev.at) / 1000;
    if (sec <= 0) continue;
    const rd = readSectors - prev.read;
    const wr = writeSectors - prev.write;
    if (rd < 0 || wr < 0) continue; // counter reset

    out.push({
      device,
      readBps: Math.round((rd * SECTOR_BYTES) / sec),
      writeBps: Math.round((wr * SECTOR_BYTES) / sec),
    });
  }

  return out;
}

function shouldSkip(dev: string): boolean {
  if (/^(loop|ram|fd|sr|dm-|md|zram)/.test(dev)) return true;
  if (/^(sd|vd|hd)[a-z]+\d+$/.test(dev)) return true; // partitions: sda1, vdb2
  if (/^nvme\d+n\d+p\d+$/.test(dev)) return true; // nvme0n1p1
  if (/^mmcblk\d+p\d+$/.test(dev)) return true; // mmcblk0p1
  return false;
}

// Expose for tests / debugging.
export function _resetDiskIoStateForTests(): void {
  prevSnapshot.clear();
}
