import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { openSync, existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { config } from "./config.js";
import { fetchWithTimeout } from "./http.js";

// Where install-agent.sh lives once the agent is installed. Re-running it
// pulls latest, rebuilds, and restarts the systemd service.
const INSTALL_SCRIPT = "/opt/homelab-agent/deploy/install-agent.sh";
const UPDATE_LOG = "/var/log/homelab-agent-update.log";

// stdin=ignore (we never write to docker), stdout/stderr=pipe (we read both).
type StreamProc = ChildProcessByStdio<null, Readable, Readable>;

const execFileAsync = promisify(execFile);

type Job = {
  id: string;
  type: string;
  payload: { dockerId?: string; containerName?: string; tail?: number };
};

// Track running stream processes so we don't spawn duplicates if the same
// job appears twice (network retry, etc.).
const activeStreams = new Map<string, StreamProc>();

const POLL_INTERVAL_MS = 3000;
let polling = false;

/**
 * Periodically fetches jobs the dashboard wants this host to execute.
 *
 * SAFETY: we never interpolate strings into a shell. Every Docker call uses
 * execFile with a fixed argv list, so a malicious dockerId from the API
 * cannot inject shell metacharacters. The dashboard already constrains job
 * types to a small allowlist, and we re-validate types here.
 */
export function startJobRunner() {
  setInterval(() => {
    if (polling) return;
    polling = true;
    pollOnce()
      .catch((err) => console.error("[agent] job poll failed:", err.message))
      .finally(() => {
        polling = false;
      });
  }, POLL_INTERVAL_MS);
}

async function pollOnce() {
  const url = `${config.dashboardUrl}/api/agent/jobs?hostname=${encodeURIComponent(
    config.hostname,
  )}`;
  const res = await fetchWithTimeout(url, { headers: { "x-agent-key": config.apiKey } });
  if (!res.ok) {
    if (res.status === 404) return; // server not yet registered; check-in loop will fix
    throw new Error(`poll -> ${res.status}`);
  }
  const data = (await res.json()) as { jobs?: Job[] };
  for (const job of data.jobs ?? []) {
    await runJob(job).catch(async (err) => {
      console.error(`[agent] job ${job.id} failed:`, err.message);
      await reportResult(job.id, "error", { error: String(err.message ?? err) });
    });
  }
}

async function runJob(job: Job) {
  // Self-update has no dockerId — handle it before the container-job checks.
  if (job.type === "agent.update") {
    await updateAgent(job.id);
    return;
  }

  const dockerId = job.payload?.dockerId;
  if (!dockerId) throw new Error("missing dockerId in payload");

  switch (job.type) {
    case "container.start":
      await docker(["start", dockerId]);
      await reportResult(job.id, "done", { action: "start", dockerId });
      return;

    case "container.stop":
      await docker(["stop", dockerId]);
      await reportResult(job.id, "done", { action: "stop", dockerId });
      return;

    case "container.restart":
      await docker(["restart", dockerId]);
      await reportResult(job.id, "done", { action: "restart", dockerId });
      return;

    case "container.logs": {
      const tail = clampTail(job.payload?.tail);
      const { stdout, stderr } = await docker([
        "logs",
        "--tail",
        String(tail),
        dockerId,
      ]);
      const lines = `${stdout}\n${stderr}`.split("\n").filter(Boolean).slice(-tail);
      await reportResult(job.id, "done", { lines });
      return;
    }

    case "container.logs.stream": {
      // Long-running. Spawn `docker logs -f`, stream stdout/stderr as chunks,
      // stop when the server returns continue=false or the process exits.
      if (activeStreams.has(job.id)) return;
      const tail = clampTail(job.payload?.tail);
      void streamLogs(job.id, dockerId, tail);
      return;
    }

    default:
      throw new Error(`unsupported job type: ${job.type}`);
  }
}

async function streamLogs(jobId: string, dockerId: string, tail: number) {
  const child: StreamProc = spawn(
    "docker",
    ["logs", "-f", "--tail", String(tail), dockerId],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  activeStreams.set(jobId, child);

  let seq = 0;
  let buf = "";
  let stopping = false;

  const stop = (status: "done" | "error", note?: string) => {
    if (stopping) return;
    stopping = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    activeStreams.delete(jobId);
    void reportResult(jobId, status, note ? { note } : {}).catch(() => {});
  };

  const onData = (data: Buffer) => {
    buf += data.toString("utf8");
    let idx;
    const lines: string[] = [];
    while ((idx = buf.indexOf("\n")) !== -1) {
      lines.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
    if (lines.length === 0) return;
    void sendChunk(jobId, seq++, lines).then((cont) => {
      if (!cont) stop("done", "cancelled by dashboard");
    });
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) => stop("error", err.message));
  child.on("close", (code) => {
    clearInterval(heartbeat);
    if (buf.length > 0) {
      void sendChunk(jobId, seq++, [buf]).catch(() => {});
      buf = "";
    }
    stop(code === 0 || code === null ? "done" : "error", `process exited (${code})`);
  });

  // Heartbeat: poll for cancel even when the container is silent.
  const heartbeat = setInterval(() => {
    if (stopping) return;
    void sendChunk(jobId, 0, []).then((cont) => {
      if (!cont) stop("done", "cancelled by dashboard");
    });
  }, 5000);
}

async function sendChunk(jobId: string, seq: number, lines: string[]): Promise<boolean> {
  try {
    const url = `${config.dashboardUrl}/api/agent/jobs/${encodeURIComponent(jobId)}/chunk`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-key": config.apiKey,
      },
      body: JSON.stringify({ hostname: config.hostname, seq, lines }),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { continue?: boolean };
    return data.continue !== false;
  } catch {
    return false;
  }
}

function clampTail(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(10, Math.min(1000, Math.floor(n)));
}

async function docker(args: string[]) {
  // execFile (not exec) — args are passed as argv, no shell interpolation.
  // timeout: a wedged docker daemon must not hang the poller forever. 60s is
  // well above a graceful `docker stop` (10s default) so we don't kill valid
  // slow operations; on timeout execFile sends SIGTERM to the docker process.
  return execFileAsync("docker", args, {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
}

/**
 * Self-update: re-run the idempotent install script (git pull → rebuild →
 * systemctl restart). We must report the result BEFORE kicking it off, because
 * the restart kills this very process mid-job. The script is spawned detached
 * (its own session, stdio to a log file) so it survives our exit; install-
 * agent.sh only restarts the service after a successful build, so a failed
 * pull/build leaves the current agent running.
 */
async function updateAgent(jobId: string) {
  if (!existsSync(INSTALL_SCRIPT)) {
    await reportResult(jobId, "error", {
      error: `install script not found at ${INSTALL_SCRIPT}`,
    });
    return;
  }

  await reportResult(jobId, "done", {
    note: "update started — pulling, rebuilding, and restarting the agent",
  });

  // Detached spawn logging to a file — the fallback when systemd-run is absent.
  const runDetachedBash = () => {
    let out: number;
    try {
      out = openSync(UPDATE_LOG, "a");
    } catch {
      out = openSync("/dev/null", "a");
    }
    const bash = spawn("bash", [INSTALL_SCRIPT], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    bash.unref();
  };

  // Prefer systemd-run: it runs the installer in its own transient unit,
  // OUTSIDE this service's cgroup, so when the script calls `systemctl restart
  // homelab-agent` the restart doesn't tear down the updater itself. Output
  // lands in journald (journalctl -u homelab-agent-update). A missing binary
  // surfaces as an async 'error' event (not a throw), so we fall back there.
  const child = spawn(
    "systemd-run",
    ["--no-block", "--collect", "--unit", "homelab-agent-update", "bash", INSTALL_SCRIPT],
    { detached: true, stdio: "ignore" },
  );
  child.once("error", runDetachedBash);
  child.unref();
}

async function reportResult(jobId: string, status: "done" | "error", result: unknown) {
  const url = `${config.dashboardUrl}/api/agent/jobs/${encodeURIComponent(jobId)}/result`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-key": config.apiKey,
    },
    body: JSON.stringify({ hostname: config.hostname, status, result }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`report -> ${res.status} ${text.slice(0, 200)}`);
  }
}
