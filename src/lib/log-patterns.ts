// Patterns in shipped log lines that are worth an ALERT, not just storage.
// We already collect warn/error lines on the Logs page; these are the few that
// signal real trouble and shouldn't wait for someone to open that page.
//
// Keep this list tight and high-signal — every entry here can page you.
export type LogPattern = {
  key: string; // stable id, used to dedupe alerts
  label: string; // human description
  re: RegExp;
  severity: "warning" | "critical";
};

export const LOG_PATTERNS: LogPattern[] = [
  // Memory pressure — the kernel killed a process to stay alive.
  { key: "oom", label: "Out-of-memory killer invoked", re: /\b(Out of memory|oom-kill|killed process \d+|invoked oom-killer)\b/i, severity: "critical" },
  // Storage trouble — bad sectors, controller resets, dropped disks.
  { key: "io-error", label: "Disk I/O error", re: /\b(I\/O error|blk_update_request|critical medium error|ata\d+\.\d+: failed|device offlined|buffer I\/O error)\b/i, severity: "critical" },
  // ZFS pool health — corruption or a degraded/faulted vdev.
  { key: "zfs", label: "ZFS error / pool degraded", re: /\bZFS\b.*\b(error|degraded|faulted|checksum|unrecoverable|suspended)\b/i, severity: "critical" },
  // Filesystem corruption.
  { key: "fs-corrupt", label: "Filesystem error", re: /\b(EXT4-fs error|Btrfs.*error|remounting filesystem read-only|metadata corruption)\b/i, severity: "critical" },
  // Software crashes.
  { key: "segfault", label: "Process crash (segfault/oops)", re: /\b(segfault|general protection fault|kernel BUG|Oops:|panic)\b/i, severity: "critical" },
  // Thermal — CPU is being throttled to avoid overheating.
  { key: "thermal", label: "Thermal throttling / overheat", re: /\b(thermal throttl|CPU\d+: Package temperature above threshold|critical temperature)\b/i, severity: "warning" },
  // Auth — a burst of failed logins (brute-force) on top of fail2ban.
  { key: "auth", label: "Repeated authentication failures", re: /\b(Failed password for|authentication failure|invalid user)\b/i, severity: "warning" },
];

export type LogMatch = { pattern: LogPattern; sample: string };

/**
 * Scan a batch of log lines and return the FIRST sample line for each distinct
 * pattern that matched (so one alert per pattern per batch, not per line).
 */
export function scanLogLines(lines: Array<{ message: string }>): LogMatch[] {
  const hits = new Map<string, LogMatch>();
  for (const line of lines) {
    for (const p of LOG_PATTERNS) {
      if (hits.has(p.key)) continue;
      if (p.re.test(line.message)) hits.set(p.key, { pattern: p, sample: line.message });
    }
    if (hits.size === LOG_PATTERNS.length) break;
  }
  return [...hits.values()];
}
