import os from "node:os";
import { promises as fs } from "node:fs";
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

export function getMemoryPercent(): number {
  const total = os.totalmem();
  const free = os.freemem();
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - free) / total) * 100));
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
