import os from "node:os";
import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** When the host booted, as an ISO timestamp. Cross-platform. */
export function getBootAt(): string {
  return new Date(Date.now() - os.uptime() * 1000).toISOString();
}

/**
 * Load averages [1min, 5min, 15min]. Linux/macOS only — Windows always
 * returns [0, 0, 0] because the concept doesn't exist there. We still emit
 * it (the dashboard can decide to hide a row of zeros).
 */
export function getLoadAvg(): [number, number, number] {
  const [a, b, c] = os.loadavg();
  return [round(a), round(b), round(c)];
}

/**
 * Is a system reboot pending?
 *
 * Linux: /var/run/reboot-required exists (Debian/Ubuntu convention).
 * Windows: a handful of registry keys / pending-operations flags. The most
 *   reliable single check is HKLM\Software\Microsoft\Windows\CurrentVersion\
 *   Component Based Servicing\RebootPending — but querying the registry
 *   requires PowerShell, which we use elsewhere too.
 *
 * macOS: no standard signal; returns false.
 */
export async function getRebootRequired(): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      await fs.access("/var/run/reboot-required");
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync(
        'powershell.exe -NoProfile -NonInteractive -Command "Test-Path \'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending\'"',
        { timeout: 10_000 },
      );
      return stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  }
  return false;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
