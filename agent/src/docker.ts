import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type DockerContainer = {
  dockerId: string;
  name: string;
  image: string;
  status: string;
  ports: Array<{ host?: string; container: string; protocol?: string }>;
};

export async function listDockerContainers(): Promise<DockerContainer[] | null> {
  // Detect Docker once per call. If it's not on PATH, callers treat the host
  // as a non-Docker box and skip the container sync gracefully.
  if (!(await hasDocker())) return null;

  try {
    // --format outputs one JSON object per line for stable parsing across versions.
    const { stdout } = await execAsync(
      'docker ps -a --no-trunc --format "{{json .}}"',
      { maxBuffer: 4 * 1024 * 1024 },
    );

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseDockerLine)
      .filter((c): c is DockerContainer => c !== null);
  } catch (err) {
    console.warn("[agent] docker ps failed:", (err as Error).message);
    return null;
  }
}

async function hasDocker(): Promise<boolean> {
  try {
    await execAsync(process.platform === "win32" ? "where docker" : "command -v docker");
    return true;
  } catch {
    return false;
  }
}

function parseDockerLine(line: string): DockerContainer | null {
  try {
    const row = JSON.parse(line) as Record<string, string>;
    return {
      dockerId: row.ID ?? row.Id ?? "",
      name: row.Names ?? row.Name ?? "",
      image: row.Image ?? "",
      status: normalizeStatus(row.State ?? row.Status ?? "unknown"),
      ports: parsePorts(row.Ports ?? ""),
    };
  } catch {
    return null;
  }
}

function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s.startsWith("up") || s === "running") return "running";
  if (s.startsWith("exited") || s === "exited") return "exited";
  if (s.includes("restart")) return "restarting";
  if (s.includes("paused")) return "paused";
  if (s.includes("dead")) return "dead";
  if (s.includes("created")) return "created";
  return s || "unknown";
}

/**
 * `docker ps` formats ports as a comma-separated list like:
 *   "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 5432/tcp"
 * We parse out (host?, container, protocol) — duplicates across IPv4/IPv6 are
 * collapsed by stringifying.
 */
function parsePorts(raw: string): DockerContainer["ports"] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: DockerContainer["ports"] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(?:.*?:(\d+)->)?(\d+)\/(\w+)$/.exec(part);
    if (!m) continue;
    const entry = { host: m[1] || undefined, container: m[2], protocol: m[3] };
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
