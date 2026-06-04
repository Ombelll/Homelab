import { readFile } from "node:fs/promises";

// Intel RAPL package energy counter (microjoules, monotonic, wraps at
// max_energy_range_uj). Reading it needs root — the host agent runs as root.
// AMD exposes the same powercap path on recent kernels; non-Intel/older hosts
// simply lack the file and we report nothing.
const ENERGY = "/sys/class/powercap/intel-rapl:0/energy_uj";
const MAXRANGE = "/sys/class/powercap/intel-rapl:0/max_energy_range_uj";

let prev: { uj: number; at: number } | null = null;
let maxRange: number | null = null;

/**
 * Whole-package power draw in watts, from the RAPL energy-counter delta between
 * ticks. Returns undefined on the first sample (needs two), on non-RAPL hosts,
 * or on an implausible reading. Host-level estimate, not a wall-socket meter.
 */
export async function getPowerWatts(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;

  let uj: number;
  try {
    uj = Number((await readFile(ENERGY, "utf8")).trim());
  } catch {
    return undefined; // no RAPL on this host
  }
  if (!Number.isFinite(uj)) return undefined;

  if (maxRange == null) {
    try {
      maxRange = Number((await readFile(MAXRANGE, "utf8")).trim());
    } catch {
      maxRange = 0;
    }
  }

  const now = Date.now();
  const p = prev;
  prev = { uj, at: now };
  if (!p) return undefined;

  const dt = (now - p.at) / 1000;
  if (dt <= 0) return undefined;

  let dj = uj - p.uj;
  if (dj < 0) {
    // Counter wrapped — add the range if we know it, else skip this sample.
    if (maxRange && Number.isFinite(maxRange) && maxRange > 0) dj += maxRange;
    else return undefined;
  }

  const watts = dj / 1_000_000 / dt; // µJ → J, then J/s = W
  if (!Number.isFinite(watts) || watts < 0 || watts > 1000) return undefined;
  return Math.round(watts * 10) / 10;
}
