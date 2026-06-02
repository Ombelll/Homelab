import os from "node:os";
import { promises as fs, readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Sample CPU usage by reading os.cpus() twice and diffing the time spent in
 * the "idle" bucket vs. the total. Cross-platform; resolution is 1 second.
 */
export async function getCpuPercent(): Promise<number> {
  const a = snapshot();
  await new Promise((r) => setTimeout(r, 1000));
  const b = snapshot();

  const idle = b.idle - a.idle;
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

function snapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Per-core CPU usage (%) over a 1s window — same diff method as
 * getCpuPercent but kept per core. Runs concurrently with getCpuPercent
 * (both sleep 1s) so it adds no wall-clock time to a tick.
 */
export async function getCpuPerCore(): Promise<number[]> {
  const a = perCoreSnapshot();
  await new Promise((r) => setTimeout(r, 1000));
  const b = perCoreSnapshot();
  const out: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const idle = b[i].idle - a[i].idle;
    const total = b[i].total - a[i].total;
    out.push(total <= 0 ? 0 : Math.max(0, Math.min(100, ((total - idle) / total) * 100)));
  }
  return out;
}

function perCoreSnapshot() {
  return os.cpus().map((cpu) => {
    const t = cpu.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

export function getMemoryPercent(): number {
  // On Linux, prefer MemAvailable from /proc/meminfo. os.freemem() maps to
  // MemFree, which counts reclaimable page cache and ZFS ARC as "used" and so
  // overstates real memory pressure — a ZFS host can read ~95% with gigabytes
  // genuinely free. MemAvailable is the kernel's estimate of what a new
  // allocation can actually get, which is what we want for alerts and gauges.
  if (process.platform === "linux") {
    try {
      const mem = readFileSync("/proc/meminfo", "utf8");
      const total = Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1] ?? 0);
      const avail = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1] ?? NaN);
      if (total > 0 && Number.isFinite(avail)) {
        return Math.max(0, Math.min(100, ((total - avail) / total) * 100));
      }
    } catch {
      // fall through to the os.freemem() path below
    }
  }
  const total = os.totalmem();
  const free = os.freemem();
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - free) / total) * 100));
}

/**
 * Swap usage (%) from /proc/meminfo. Linux only; returns 0 when there's no
 * swap configured, and undefined on non-Linux / read failure so the field
 * is simply omitted from the report.
 */
export async function getSwapPercent(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const mem = await fs.readFile("/proc/meminfo", "utf8");
    const total = Number(/SwapTotal:\s+(\d+)/.exec(mem)?.[1] ?? 0);
    const free = Number(/SwapFree:\s+(\d+)/.exec(mem)?.[1] ?? 0);
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, ((total - free) / total) * 100));
  } catch {
    return undefined;
  }
}

/**
 * Best-effort disk usage for the root filesystem. Works on Linux/macOS via
 * `df`; on Windows we shell out to `wmic`. If neither is available we return
 * null so callers can default to 0.
 */
export async function getDiskPercent(): Promise<number> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execAsync(
        'wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /format:value',
      );
      const free = Number(/FreeSpace=(\d+)/.exec(stdout)?.[1] ?? 0);
      const size = Number(/Size=(\d+)/.exec(stdout)?.[1] ?? 0);
      if (size <= 0) return 0;
      return Math.max(0, Math.min(100, ((size - free) / size) * 100));
    }
    const { stdout } = await execAsync("df -kP /");
    const lines = stdout.trim().split("\n");
    const parts = lines[lines.length - 1].split(/\s+/);
    const usedPct = parts[4]?.replace("%", "");
    const num = Number(usedPct);
    return Number.isFinite(num) ? num : 0;
  } catch {
    return 0;
  }
}

/**
 * Try to find a usable IPv4 address for outbound traffic — picks the first
 * non-internal IPv4 from the network interfaces.
 */
export function getIpAddress(): string | undefined {
  // os.networkInterfaces() can throw EAFNOSUPPORT (errno 97) on some kernels
  // when an interface uses an address family libuv doesn't recognise — notably
  // VPN/tunnel devices like tailscale0/wireguard. Interface enumeration is
  // best-effort, so never let it crash the check-in.
  let ifaces: ReturnType<typeof os.networkInterfaces>;
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return undefined;
  }
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return undefined;
}

export async function getOsDescription(): Promise<string> {
  // os.version() is undefined on some older Node releases — fall back gracefully.
  const base = `${os.type()} ${os.release()}`.trim();
  if (process.platform !== "linux") return base;
  try {
    const release = await fs.readFile("/etc/os-release", "utf8");
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
    return pretty?.trim() || base;
  } catch {
    return base;
  }
}
