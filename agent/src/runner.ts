import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

type Job = {
  id: string;
  type: string;
  payload: { dockerId?: string; containerName?: string; tail?: number };
};

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
  const res = await fetch(url, { headers: { "x-agent-key": config.apiKey } });
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

    default:
      throw new Error(`unsupported job type: ${job.type}`);
  }
}

function clampTail(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(10, Math.min(1000, Math.floor(n)));
}

async function docker(args: string[]) {
  // execFile (not exec) — args are passed as argv, no shell interpolation.
  return execFileAsync("docker", args, { maxBuffer: 4 * 1024 * 1024 });
}

async function reportResult(jobId: string, status: "done" | "error", result: unknown) {
  const url = `${config.dashboardUrl}/api/agent/jobs/${encodeURIComponent(jobId)}/result`;
  const res = await fetch(url, {
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
