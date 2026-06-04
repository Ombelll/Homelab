import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Run docker with a fixed argv list — NEVER a shell. Mirrors runner.ts: even
// though every command here is static today, argv form means a value that
// ever reaches an argument (a container id/name) can't inject shell
// metacharacters. `command -v docker` is intentionally avoided for the same
// reason (it needs a shell); we probe with `docker --version` instead.
function docker(args: string[], maxBuffer = 4 * 1024 * 1024) {
  return execFileAsync("docker", args, { maxBuffer, timeout: 30_000 });
}

export type DockerContainer = {
  dockerId: string;
  name: string;
  image: string;
  imageDigest?: string;
  status: string;
  // Docker healthcheck state ("healthy" | "unhealthy" | "starting"), parsed
  // from the human Status string. Undefined when the image has no HEALTHCHECK.
  health?: string;
  ports: Array<{ host?: string; container: string; protocol?: string }>;
  composeProject?: string;
  composeService?: string;
  // Per-container stats. Optional because `docker stats` can fail or be
  // unsupported on some platforms; we ship what we have.
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  // Total restarts since creation (from `docker inspect`). High values
  // indicate a crashloop.
  restartCount?: number;
  // True if the container's last run was killed by the OOM killer (hit its
  // memory limit). A clear, actionable signal — drives an alert.
  oomKilled?: boolean;
};

export async function listDockerContainers(): Promise<DockerContainer[] | null> {
  if (!(await hasDocker())) return null;

  try {
    const { stdout } = await docker(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]);

    const base = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseDockerLine)
      .filter((c): c is DockerContainer => c !== null);

    // Decorate with image digests (best-effort). `docker images --digests`
    // produces one row per image with both ImageID and Digest. We map by
    // image reference so each container can find its row.
    const digests = await readImageDigests().catch(() => new Map<string, string>());
    for (const c of base) {
      const d = digests.get(c.image);
      if (d) c.imageDigest = d;
    }

    // Decorate with stats (best-effort). `docker stats --no-stream` returns
    // one row per running container, with --format json one per line.
    const stats = await readStats().catch(() => new Map<string, ContainerStats>());

    for (const c of base) {
      const s = stats.get(c.dockerId) ?? stats.get(c.name);
      if (s) {
        c.cpuPercent = s.cpuPercent;
        c.memoryBytes = s.memoryBytes;
        c.memoryLimitBytes = s.memoryLimitBytes;
      }
    }

    // Decorate with inspect data (restart count, OOM-killed, configured memory
    // limit) — one inspect for the whole list. A configured cgroup limit
    // overrides the stats limit, which falls back to host RAM when unset.
    if (base.length > 0) {
      const insp = await readInspect(base.map((c) => c.dockerId)).catch(
        () => new Map<string, InspectInfo>(),
      );
      for (const c of base) {
        const i = insp.get(c.dockerId);
        if (!i) continue;
        if (typeof i.restartCount === "number") c.restartCount = i.restartCount;
        c.oomKilled = i.oomKilled;
        if (i.memLimit && i.memLimit > 0) c.memoryLimitBytes = i.memLimit;
      }
    }

    return base;
  } catch (err) {
    console.warn("[agent] docker ps failed:", (err as Error).message);
    return null;
  }
}

async function hasDocker(): Promise<boolean> {
  try {
    // `docker --version` only touches the client binary (no daemon), which is
    // all we need to decide whether to attempt the rest. argv form, no shell.
    await docker(["--version"], 256 * 1024);
    return true;
  } catch {
    return false;
  }
}

function parseDockerLine(line: string): DockerContainer | null {
  try {
    const row = JSON.parse(line) as Record<string, string>;
    const { project, service } = parseLabels(row.Labels ?? "");
    return {
      dockerId: row.ID ?? row.Id ?? "",
      name: row.Names ?? row.Name ?? "",
      image: row.Image ?? "",
      status: normalizeStatus(row.State ?? row.Status ?? "unknown"),
      health: parseHealth(row.Status ?? ""),
      ports: parsePorts(row.Ports ?? ""),
      composeProject: project,
      composeService: service,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the Docker healthcheck state from the human Status string, e.g.
 * "Up 2 hours (healthy)" → "healthy", "Up (unhealthy)" → "unhealthy",
 * "Up (health: starting)" → "starting". Returns undefined when the image
 * declares no HEALTHCHECK (no parenthetical), so we never invent a value.
 */
export function parseHealth(rawStatus: string): string | undefined {
  const s = rawStatus.toLowerCase();
  if (s.includes("(healthy)")) return "healthy";
  if (s.includes("(unhealthy)")) return "unhealthy";
  if (s.includes("health: starting")) return "starting";
  return undefined;
}

export function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s.startsWith("up") || s === "running") return "running";
  if (s.startsWith("exited") || s === "exited") return "exited";
  if (s.includes("restart")) return "restarting";
  if (s.includes("paused")) return "paused";
  if (s.includes("dead")) return "dead";
  if (s.includes("created")) return "created";
  return s || "unknown";
}

export function parsePorts(raw: string): DockerContainer["ports"] {
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

/**
 * `docker ps --format` writes labels as a comma-separated `k=v,k=v` string.
 * We only care about the two standard compose labels.
 */
export function parseLabels(raw: string): { project?: string; service?: string } {
  const out: { project?: string; service?: string } = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key === "com.docker.compose.project") out.project = val;
    else if (key === "com.docker.compose.service") out.service = val;
  }
  return out;
}

type ContainerStats = {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
};

type InspectInfo = { restartCount?: number; oomKilled?: boolean; memLimit?: number };

/**
 * Map dockerId → inspect facts (restart count, OOM-killed, configured memory
 * limit in bytes). One `docker inspect` for the whole list, pipe-delimited
 * Go template so whitespace can't split a field.
 */
async function readInspect(ids: string[]): Promise<Map<string, InspectInfo>> {
  if (ids.length === 0) return new Map();
  const { stdout } = await docker(
    [
      "inspect",
      "--format",
      "{{.Id}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{.HostConfig.Memory}}",
      ...ids,
    ],
    2 * 1024 * 1024,
  );
  const map = new Map<string, InspectInfo>();
  for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [id, restart, oom, mem] = line.split("|");
    if (!id) continue;
    const rc = Number(restart);
    const ml = Number(mem);
    map.set(id, {
      restartCount: Number.isFinite(rc) ? rc : undefined,
      oomKilled: oom === "true",
      memLimit: Number.isFinite(ml) ? ml : undefined,
    });
  }
  return map;
}

/**
 * Map image reference ("repo:tag") → manifest digest (sha256:…). We read
 * `docker images --digests --no-trunc` and skip rows where Docker reports
 * <none> for the digest (locally-built or untagged images).
 */
async function readImageDigests(): Promise<Map<string, string>> {
  const { stdout } = await docker(["images", "--digests", "--no-trunc", "--format", "{{json .}}"]);
  const map = new Map<string, string>();
  for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const row = JSON.parse(line) as Record<string, string>;
      const repo = (row.Repository ?? "").trim();
      const tag = (row.Tag ?? "").trim();
      const digest = (row.Digest ?? "").trim();
      if (!repo || !tag || !digest || digest === "<none>") continue;
      map.set(`${repo}:${tag}`, digest);
    } catch {
      /* skip malformed row */
    }
  }
  return map;
}

async function readStats(): Promise<Map<string, ContainerStats>> {
  const { stdout } = await docker(["stats", "--no-stream", "--format", "{{json .}}"]);
  const map = new Map<string, ContainerStats>();
  for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const row = JSON.parse(line) as Record<string, string>;
      const cpu = parsePercent(row.CPUPerc);
      const mem = parseMemUsage(row.MemUsage);
      if (cpu == null || !mem) continue;
      const id = (row.ID ?? row.Id ?? "").trim();
      const name = (row.Name ?? "").trim();
      const stats: ContainerStats = {
        cpuPercent: cpu,
        memoryBytes: mem.used,
        memoryLimitBytes: mem.limit,
      };
      if (id) map.set(id, stats);
      if (name) map.set(name, stats);
    } catch {
      /* skip malformed row */
    }
  }
  return map;
}

function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

// "123MiB / 4GiB" → { used: 128974848, limit: 4294967296 }
function parseMemUsage(raw: string | undefined): { used: number; limit: number } | null {
  if (!raw) return null;
  const [left, right] = raw.split("/").map((s) => s.trim());
  if (!left || !right) return null;
  const used = parseSize(left);
  const limit = parseSize(right);
  if (used == null || limit == null) return null;
  return { used, limit };
}

const UNITS: Record<string, number> = {
  B: 1,
  KIB: 1024,
  KB: 1000,
  MIB: 1024 ** 2,
  MB: 1000 ** 2,
  GIB: 1024 ** 3,
  GB: 1000 ** 3,
  TIB: 1024 ** 4,
  TB: 1000 ** 4,
};

function parseSize(raw: string): number | null {
  const m = /^([\d.]+)\s*([KMGTP]?i?B)$/i.exec(raw.trim());
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  const unit = UNITS[m[2].toUpperCase()];
  if (!Number.isFinite(num) || !unit) return null;
  return num * unit;
}
