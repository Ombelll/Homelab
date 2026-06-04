import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LogLine = { source: string; message: string; at?: string };

// Only ship lines that look like a problem — keeps volume sane and the store
// useful. (Full-fidelity logging belongs in a dedicated stack, not here.)
const INTERESTING = /\b(error|err|warn|fail|failed|fatal|panic|critical|denied|refused|timeout|exception)\b/i;

// A touch longer than the 5-min ship cadence so nothing slips through the gap.
const SINCE = "6 min ago";
const PER_SOURCE_CAP = 100;

function clip(s: string): string {
  return s.length > 2000 ? s.slice(0, 2000) : s;
}

/** Host journal warnings+errors (Linux only). */
async function hostJournal(): Promise<LogLine[]> {
  if (process.platform !== "linux") return [];
  try {
    const { stdout } = await execFileAsync(
      "journalctl",
      ["--since", SINCE, "-p", "warning", "--no-pager", "-o", "short-iso", "-q"],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-PER_SOURCE_CAP)
      .map((message) => ({ source: "host", message: clip(message) }));
  } catch {
    return [];
  }
}

/** Recent interesting lines from one container's logs (stdout + stderr). */
async function containerLogs(name: string): Promise<LogLine[]> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["logs", "--since", "6m", "--tail", "500", "--timestamps", name],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
    );
    const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
    const out: LogLine[] = [];
    for (const line of lines) {
      if (!INTERESTING.test(line)) continue;
      // docker --timestamps prefixes RFC3339Nano + space.
      const sp = line.indexOf(" ");
      const ts = sp > 0 ? line.slice(0, sp) : undefined;
      const at = ts && /^\d{4}-\d\d-\d\dT/.test(ts) ? ts : undefined;
      const message = at ? line.slice(sp + 1) : line;
      out.push({ source: name, message: clip(message), at });
    }
    return out.slice(-PER_SOURCE_CAP);
  } catch {
    return [];
  }
}

/**
 * Collect shippable log lines: host journal warnings/errors plus interesting
 * lines from each running container. `containers` comes from the docker
 * collector (null on non-docker hosts). Hard-capped overall.
 */
export async function getLogs(containerNames: string[] | null): Promise<LogLine[]> {
  const out: LogLine[] = [];
  out.push(...(await hostJournal()));
  if (containerNames) {
    for (const name of containerNames) {
      out.push(...(await containerLogs(name)));
    }
  }
  return out.slice(0, 1000);
}
