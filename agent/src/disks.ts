import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Run a PowerShell snippet via execFile (no shell parsing) and return
 * stdout. Used for Windows-only paths where we'd otherwise reach for the
 * deprecated wmic utility.
 */
async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

export type DiskUsage = {
  mountpoint: string;
  fstype?: string;
  totalBytes: number;
  usedBytes: number;
};

const SKIP_FSTYPES = new Set([
  "tmpfs",
  "devtmpfs",
  "squashfs",
  "overlay",
  "fuse",
  "fuse.gvfsd-fuse",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "devpts",
  "mqueue",
  "configfs",
  "debugfs",
  "tracefs",
  "pstore",
  "bpf",
  "ramfs",
  "nsfs",
  "autofs",
  "hugetlbfs",
  "binfmt_misc",
  "rpc_pipefs",
]);

const SKIP_MOUNTPOINT_PREFIXES = ["/snap/", "/run/", "/dev/", "/sys/", "/proc/"];

/**
 * Cross-platform mountpoint usage. Linux/macOS use `df -kPT`; Windows uses
 * `wmic logicaldisk`. We filter out pseudo-filesystems (tmpfs, overlay,
 * snap mounts) so the dashboard only shows real disks.
 */
export async function getDisks(): Promise<DiskUsage[]> {
  try {
    if (process.platform === "win32") return await readDisksWindows();
    return await readDisksUnix();
  } catch (err) {
    console.warn("[agent] disk enumeration failed:", (err as Error).message);
    return [];
  }
}

async function readDisksUnix(): Promise<DiskUsage[]> {
  // -k = KiB, -P = POSIX output (one row per fs), -T = print fstype.
  // macOS df accepts -k/-P but uses -T differently; fall back if it errors.
  let stdout: string;
  try {
    ({ stdout } = await execAsync("df -kPT"));
  } catch {
    ({ stdout } = await execAsync("df -kP"));
  }

  const lines = stdout.trim().split("\n").slice(1);
  const out: DiskUsage[] = [];
  for (const line of lines) {
    const cols = line.split(/\s+/);
    // With -T: Filesystem Type 1024-blocks Used Available Capacity Mounted-on
    // Without:  Filesystem      1024-blocks Used Available Capacity Mounted-on
    const hasType = cols.length >= 7;
    const fstype = hasType ? cols[1] : undefined;
    const totalKb = Number(cols[hasType ? 2 : 1]);
    const usedKb = Number(cols[hasType ? 3 : 2]);
    const mountpoint = cols[hasType ? 6 : 5];

    if (!Number.isFinite(totalKb) || totalKb <= 0) continue;
    if (!mountpoint) continue;
    if (fstype && SKIP_FSTYPES.has(fstype.toLowerCase())) continue;
    if (SKIP_MOUNTPOINT_PREFIXES.some((p) => mountpoint.startsWith(p))) continue;
    if (mountpoint.startsWith("/var/lib/docker/")) continue;

    out.push({
      mountpoint,
      fstype,
      totalBytes: totalKb * 1024,
      usedBytes: usedKb * 1024,
    });
  }
  return dedupe(out);
}

async function readDisksWindows(): Promise<DiskUsage[]> {
  // Prefer PowerShell's Get-Volume — wmic is deprecated on Windows 11+
  // and Microsoft has flagged it for removal.
  try {
    return await readDisksWindowsPowerShell();
  } catch (err) {
    console.warn(
      "[agent] PowerShell disk read failed, falling back to wmic:",
      (err as Error).message,
    );
  }
  return await readDisksWindowsWmic();
}

async function readDisksWindowsPowerShell(): Promise<DiskUsage[]> {
  // ForEach-Object wrapper forces array shape even with a single volume —
  // a bare object can't be iterated. Get-Volume produces one row per
  // fixed-drive volume; DriveType 'Fixed' filters out CDs and removables.
  const script = `
    @(Get-Volume | Where-Object { $_.DriveType -eq 'Fixed' -and $_.Size -gt 0 } |
      ForEach-Object {
        [PSCustomObject]@{
          DriveLetter = if ($_.DriveLetter) { "$($_.DriveLetter):" } else { $_.Path }
          FileSystem = $_.FileSystem
          Size = [int64]$_.Size
          SizeRemaining = [int64]$_.SizeRemaining
        }
      }) | ConvertTo-Json -Compress -Depth 2
  `.trim();
  const stdout = await runPowerShell(script);
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // ConvertTo-Json emits a bare object when only one volume exists.
  const parsed: unknown = JSON.parse(trimmed.startsWith("[") ? trimmed : `[${trimmed}]`);
  if (!Array.isArray(parsed)) return [];

  const out: DiskUsage[] = [];
  for (const row of parsed as Array<Record<string, unknown>>) {
    const mountpoint = String(row.DriveLetter ?? "");
    const size = Number(row.Size ?? 0);
    const free = Number(row.SizeRemaining ?? 0);
    if (!mountpoint || !Number.isFinite(size) || size <= 0) continue;
    out.push({
      mountpoint,
      fstype: typeof row.FileSystem === "string" ? row.FileSystem : undefined,
      totalBytes: size,
      usedBytes: Math.max(0, size - free),
    });
  }
  return out;
}

async function readDisksWindowsWmic(): Promise<DiskUsage[]> {
  const { stdout } = await execAsync(
    'wmic logicaldisk where "DriveType=3" get DeviceID,FileSystem,Size,FreeSpace /format:csv',
  );
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Node"));
  const out: DiskUsage[] = [];
  for (const line of lines) {
    const cols = line.split(",");
    // Node,DeviceID,FileSystem,FreeSpace,Size
    if (cols.length < 5) continue;
    const deviceId = cols[1];
    const fstype = cols[2];
    const free = Number(cols[3]);
    const total = Number(cols[4]);
    if (!deviceId || !Number.isFinite(total) || total <= 0) continue;
    out.push({
      mountpoint: deviceId,
      fstype: fstype || undefined,
      totalBytes: total,
      usedBytes: total - free,
    });
  }
  return out;
}

function dedupe(rows: DiskUsage[]): DiskUsage[] {
  const seen = new Set<string>();
  const out: DiskUsage[] = [];
  for (const r of rows) {
    if (seen.has(r.mountpoint)) continue;
    seen.add(r.mountpoint);
    out.push(r);
  }
  return out;
}
