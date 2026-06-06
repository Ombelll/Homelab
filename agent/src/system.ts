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

/**
 * Number of running processes (count of /proc/[pid] dirs). Linux only;
 * undefined elsewhere so the field is omitted.
 */
export async function getProcessCount(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const entries = await fs.readdir("/proc");
    return entries.filter((e) => /^\d+$/.test(e)).length;
  } catch {
    return undefined;
  }
}

/**
 * Count of failed systemd units — a cheap, high-signal health indicator.
 * Linux + systemd only; undefined otherwise (or if systemctl is absent).
 */
export async function getFailedUnits(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const { stdout } = await execAsync(
      "systemctl list-units --state=failed --no-legend --plain --no-pager",
      { timeout: 5_000 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean).length;
  } catch {
    return undefined;
  }
}

/**
 * Age in hours of the newest backup file in AGENT_BACKUP_DIR (default the
 * Proxmox vzdump dir). Lets the dashboard alert when backups go stale/stop.
 * Returns undefined when the dir is absent (non-backup hosts) or empty, so
 * only the host that actually holds backups reports — and thus is the only
 * one that can trip the backup-stale alert. Linux only.
 */
export async function getBackupInfo(): Promise<{ ageHours: number; bytes?: number } | undefined> {
  if (process.platform !== "linux") return undefined;
  const dir = process.env.AGENT_BACKUP_DIR || "/tank/backups/dump";
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined; // dir missing → this host doesn't hold backups
  }
  let newest = 0;
  // vzdump writes one archive PER guest into the same dir, so "the newest
  // archive" alternates between a small CT and a big one — naively tracking it
  // produced false "backup shrank" alerts. Instead track the newest archive
  // PER guest and report the SUM, which is stable run-to-run and only drops if
  // a guest's backup actually truncates/fails.
  const perGuest = new Map<string, { mtime: number; size: number }>();
  for (const e of entries) {
    if (!e.startsWith("vzdump")) continue; // backup archives + their logs
    try {
      const st = await fs.stat(`${dir}/${e}`);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (/\.(log|notes)$/i.test(e)) continue; // archives only for the size sum
      // e.g. vzdump-lxc-100-2026_06_05-03_00_02.tar.zst / vzdump-qemu-201-...
      const m = /^vzdump-(?:lxc|qemu)-(\d+)-/.exec(e);
      const guest = m ? m[1] : e; // fall back to the filename if it doesn't match
      const cur = perGuest.get(guest);
      if (!cur || st.mtimeMs > cur.mtime) perGuest.set(guest, { mtime: st.mtimeMs, size: st.size });
    } catch {
      /* file vanished between readdir and stat */
    }
  }
  if (newest === 0) return undefined; // no backups found
  const bytes =
    perGuest.size > 0 ? [...perGuest.values()].reduce((a, g) => a + g.size, 0) : undefined;
  return {
    ageHours: Math.round(((Date.now() - newest) / 3_600_000) * 10) / 10,
    bytes,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
