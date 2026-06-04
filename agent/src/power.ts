import { readFile, readdir } from "node:fs/promises";

// Intel RAPL energy counters (microjoules, monotonic, wrap at
// max_energy_range_uj). Reading them needs root — the host agent runs as root.
//
// We sum every top-level *package* domain (intel-rapl:0, :1, … on multi-socket)
// plus any separate *dram* sub-domain, because the package counter excludes RAM
// power. Reading only intel-rapl:0 (package-0) undercounts — that's why the
// first cut reported a suspiciously low figure. We deliberately skip "psys"
// zones: psys already includes package+dram, so adding it would double-count.
// AMD exposes the same powercap paths on recent kernels.
const POWERCAP = "/sys/class/powercap";

// Discovered once: the set of energy_uj files whose deltas we sum.
let energyPaths: string[] | null = null;
const prevByPath = new Map<string, number>();
const maxRangeByPath = new Map<string, number>();
let prevAt = 0;

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Find package + dram energy files under /sys/class/powercap. */
async function discoverEnergyPaths(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(POWERCAP);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!/^intel-rapl:\d+$/.test(e)) continue; // top-level zone only
    const name = await readTrimmed(`${POWERCAP}/${e}/name`);
    // Skip psys (would double-count) and anything that isn't a CPU package.
    if (name && !name.startsWith("package")) continue;
    out.push(`${POWERCAP}/${e}/energy_uj`);

    // Add this package's "dram" sub-domain, if the platform exposes one.
    let subs: string[] = [];
    try {
      subs = await readdir(`${POWERCAP}/${e}`);
    } catch {
      subs = [];
    }
    const subRe = new RegExp(`^${e}:\\d+$`);
    for (const s of subs) {
      if (!subRe.test(s)) continue;
      const sn = await readTrimmed(`${POWERCAP}/${e}/${s}/name`);
      if (sn === "dram") out.push(`${POWERCAP}/${e}/${s}/energy_uj`);
    }
  }
  // Fallback to the classic single path if discovery turned up nothing but the
  // canonical file is nonetheless present (older /sys layouts).
  if (out.length === 0 && (await readTrimmed(`${POWERCAP}/intel-rapl:0/energy_uj`)) != null) {
    out.push(`${POWERCAP}/intel-rapl:0/energy_uj`);
  }
  return out;
}

/**
 * Whole-system power draw in watts from the RAPL energy-counter deltas across
 * all package + dram domains, between ticks. Returns undefined on the first
 * sample (needs two), on non-RAPL hosts, or on an implausible reading. A
 * host-level estimate (CPU + RAM), not a wall-socket meter.
 */
export async function getPowerWatts(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;

  if (energyPaths == null) energyPaths = await discoverEnergyPaths();
  if (energyPaths.length === 0) return undefined;

  const now = Date.now();
  const dt = prevAt === 0 ? 0 : (now - prevAt) / 1000;

  let totalDj = 0;
  let haveAll = true;

  for (const path of energyPaths) {
    const raw = await readTrimmed(path);
    const uj = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(uj)) {
      haveAll = false;
      continue;
    }
    const prev = prevByPath.get(path);
    prevByPath.set(path, uj);
    if (prev == null) {
      haveAll = false;
      continue;
    }
    let dj = uj - prev;
    if (dj < 0) {
      // Counter wrapped — add this domain's range if known, else skip it.
      let range = maxRangeByPath.get(path);
      if (range == null) {
        const r = await readTrimmed(path.replace(/energy_uj$/, "max_energy_range_uj"));
        range = r == null ? 0 : Number(r);
        if (!Number.isFinite(range)) range = 0;
        maxRangeByPath.set(path, range);
      }
      if (range > 0) dj += range;
      else {
        haveAll = false;
        continue;
      }
    }
    totalDj += dj;
  }

  prevAt = now;
  if (dt <= 0 || !haveAll) return undefined; // need a clean two-sample window

  const watts = totalDj / 1_000_000 / dt; // µJ → J, then J/s = W
  if (!Number.isFinite(watts) || watts < 0 || watts > 1000) return undefined;
  return Math.round(watts * 10) / 10;
}
