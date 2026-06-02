import { promises as fs } from "node:fs";

export type TopProcess = { pid: number; name: string; cpuPercent: number; memBytes: number };

// getpagesize() is 4 KiB on every mainstream Linux arch (x86_64/arm64). We'd
// have to shell out to read it exactly; the constant is safe here.
const PAGE_SIZE = 4096;
// sysconf(_SC_CLK_TCK) — 100 on virtually all Linux kernels. Used to convert
// the jiffies in /proc/<pid>/stat into seconds of CPU time.
const CLK_TCK = 100;

type Sample = { at: number; ticks: Map<number, number> };

/**
 * Top processes by CPU over a ~1s window, each with its resident memory.
 * Linux only (reads /proc); returns [] elsewhere or on any read failure.
 *
 * Method mirrors getCpuPerCore: sample utime+stime jiffies for every PID,
 * sleep, sample again, and rank by the delta. Because it sleeps the same 1s
 * the CPU collectors already do — and they all run concurrently in the tick —
 * it adds no wall-clock time.
 *
 * CPU% is per-core-normalised like `top`: a process pinning one core reads
 * ~100%, so a busy multi-threaded process can exceed 100.
 */
export async function getTopProcesses(limit = 6): Promise<TopProcess[]> {
  if (process.platform !== "linux") return [];

  const a = await sampleTicks();
  if (!a) return [];
  await new Promise((r) => setTimeout(r, 1000));
  const b = await sampleTicks();
  if (!b) return [];

  const elapsedSec = (b.at - a.at) / 1000;
  if (elapsedSec <= 0) return [];

  const ranked: Array<{ pid: number; cpuPercent: number }> = [];
  for (const [pid, end] of b.ticks) {
    const start = a.ticks.get(pid);
    if (start === undefined) continue; // born mid-window — no baseline
    const delta = end - start;
    if (delta <= 0) continue;
    ranked.push({ pid, cpuPercent: (delta / CLK_TCK / elapsedSec) * 100 });
  }
  ranked.sort((x, y) => y.cpuPercent - x.cpuPercent);

  // Only read comm/RSS for the handful we'll actually show — these are extra
  // syscalls per PID, so we don't want them for every process on the box.
  const out: TopProcess[] = [];
  for (const { pid, cpuPercent } of ranked.slice(0, limit)) {
    const name = await readComm(pid);
    if (name == null) continue; // died between sampling and the detail read
    out.push({
      pid,
      name,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memBytes: await readRss(pid),
    });
  }
  return out;
}

async function sampleTicks(): Promise<Sample | null> {
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return null;
  }
  const at = Date.now();
  const ticks = new Map<number, number>();
  await Promise.all(
    entries.map(async (e) => {
      if (!/^\d+$/.test(e)) return;
      try {
        const stat = await fs.readFile(`/proc/${e}/stat`, "utf8");
        // comm (field 2) is wrapped in parens and may itself contain spaces or
        // ')', so split on the LAST ')'. The remainder starts at field 3
        // (state), so field N lives at index N-3: utime=14 → [11], stime=15 → [12].
        const close = stat.lastIndexOf(")");
        if (close < 0) return;
        const rest = stat.slice(close + 2).split(" ");
        const utime = Number(rest[11]);
        const stime = Number(rest[12]);
        if (!Number.isFinite(utime) || !Number.isFinite(stime)) return;
        ticks.set(Number(e), utime + stime);
      } catch {
        // process exited between readdir and read — skip it
      }
    }),
  );
  return { at, ticks };
}

async function readComm(pid: number): Promise<string | null> {
  try {
    const c = await fs.readFile(`/proc/${pid}/comm`, "utf8");
    return c.trim() || null;
  } catch {
    return null;
  }
}

async function readRss(pid: number): Promise<number> {
  try {
    const statm = await fs.readFile(`/proc/${pid}/statm`, "utf8");
    const residentPages = Number(statm.split(" ")[1]); // field 2 = resident set
    return Number.isFinite(residentPages) ? residentPages * PAGE_SIZE : 0;
  } catch {
    return 0;
  }
}
