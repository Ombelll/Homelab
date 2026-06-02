import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export type NetworkRate = { iface: string; rxBps: number; txBps: number };

type Snapshot = { rx: number; tx: number; at: number };

// In-process state so we can compute deltas between agent ticks. Reset
// when the iface disappears (e.g. unplugged USB-Ethernet) — handled by
// the `if (!prev)` branch below.
const prevSnapshot = new Map<string, Snapshot>();

/**
 * Best-effort per-interface network throughput as bytes/second. First
 * tick after agent start returns [] because we need two snapshots to
 * compute a delta. We skip loopback and Docker bridge interfaces — those
 * inflate the totals and aren't actionable.
 */
export async function getNetworkRates(): Promise<NetworkRate[]> {
  try {
    if (process.platform === "linux") return await readLinux();
    // macOS + Windows: read via os.networkInterfaces() doesn't expose byte
    // counters; would require netstat parsing or wmic. Skip for now —
    // can be added later if anyone cares.
    return [];
  } catch (err) {
    console.warn("[agent] network rates failed:", (err as Error).message);
    return [];
  }
}

async function readLinux(): Promise<NetworkRate[]> {
  const ifaces = await fs.readdir("/sys/class/net").catch(() => [] as string[]);
  const now = Date.now();
  const out: NetworkRate[] = [];

  for (const iface of ifaces) {
    if (shouldSkip(iface)) continue;

    let rx: number, tx: number;
    try {
      rx = Number(await fs.readFile(path.join("/sys/class/net", iface, "statistics", "rx_bytes"), "utf8"));
      tx = Number(await fs.readFile(path.join("/sys/class/net", iface, "statistics", "tx_bytes"), "utf8"));
    } catch {
      continue;
    }
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;

    const prev = prevSnapshot.get(iface);
    prevSnapshot.set(iface, { rx, tx, at: now });

    if (!prev) continue; // first tick — no baseline yet
    const elapsedSec = (now - prev.at) / 1000;
    if (elapsedSec <= 0) continue;

    // Guard against counter wrap-around / iface reset (kernel restarts the
    // counter at 0 on certain operations). Negative delta → skip this tick.
    const rxDelta = rx - prev.rx;
    const txDelta = tx - prev.tx;
    if (rxDelta < 0 || txDelta < 0) continue;

    out.push({
      iface,
      rxBps: Math.round(rxDelta / elapsedSec),
      txBps: Math.round(txDelta / elapsedSec),
    });
  }

  return out;
}

function shouldSkip(iface: string): boolean {
  if (iface === "lo") return true;
  if (iface.startsWith("docker")) return true;
  if (iface.startsWith("veth")) return true;
  if (iface.startsWith("br-")) return true;
  if (iface.startsWith("cni")) return true;
  if (iface.startsWith("flannel")) return true;
  if (iface.startsWith("tap")) return true;
  return false;
}

// Expose for tests / debugging.
export function _resetNetworkStateForTests(): void {
  prevSnapshot.clear();
}

// Silence "unused import" if a future refactor stops using os.
void os;
