import { execFile } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { notifyAlert } from "@/lib/notifications";

const execFileAsync = promisify(execFile);

// Threshold (in consecutive down probes) before we open an alert. Avoids
// firing on a single transient failure.
const ALERT_AFTER_CONSECUTIVE = 2;

// Cert-expiry thresholds (days). Warn three weeks out, escalate to critical
// inside a week — enough lead time to renew a Let's Encrypt / internal CA cert.
const CERT_WARN_DAYS = 21;
const CERT_CRIT_DAYS = 7;

export type CheckType = "http" | "tcp" | "ping" | "tls";

export type CheckResult =
  | { ok: true; latencyMs: number; certExpiresAt?: Date }
  | { ok: false; latencyMs?: number; error: string };

/**
 * Run a single probe of the given check. The 'ping' type uses the system
 * `ping` binary; arguments are validated to a plain hostname/IP so no shell
 * interpolation can leak through. HTTP uses fetch with AbortController for
 * timeout; TCP opens and closes a socket.
 */
export async function runProbe(input: {
  type: CheckType;
  target: string;
  timeoutMs: number;
  expectedStatus?: number | null;
}): Promise<CheckResult> {
  switch (input.type) {
    case "http":
      return runHttp(input.target, input.timeoutMs, input.expectedStatus ?? null);
    case "tcp":
      return runTcp(input.target, input.timeoutMs);
    case "ping":
      return runPing(input.target, input.timeoutMs);
    case "tls":
      return runTls(input.target, input.timeoutMs);
  }
}

/**
 * TLS reachability + certificate expiry. target is "host" (defaults to :443)
 * or "host:port". We open a TLS connection with rejectUnauthorized:false — we
 * care about the certificate's notAfter, not whether it chains to a trusted CA
 * (homelab services often use an internal CA or self-signed certs). "up" means
 * the handshake completed and we read an expiry; the cert-expiry *alert* is
 * raised separately by the runner based on days remaining.
 */
async function runTls(target: string, timeoutMs: number): Promise<CheckResult> {
  const m = /^([^\s:]+)(?::(\d+))?$/.exec(target.trim());
  if (!m) return { ok: false, error: 'target must be "host" or "host:port"' };
  const host = m[1];
  const port = m[2] ? Number(m[2]) : 443;

  const start = Date.now();
  return await new Promise<CheckResult>((resolve) => {
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return finish({ ok: false, error: "no certificate" });
        const expires = new Date(cert.valid_to);
        if (Number.isNaN(expires.getTime())) {
          return finish({ ok: false, error: "unparseable cert expiry" });
        }
        finish({ ok: true, latencyMs: Date.now() - start, certExpiresAt: expires });
      },
    );
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    socket.once("error", (err) => finish({ ok: false, error: err.message }));
  });
}

async function runHttp(
  url: string,
  timeoutMs: number,
  expectedStatus: number | null,
): Promise<CheckResult> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Most homelab services use self-signed certs over Tailscale / LAN.
      // We don't disable cert validation by default — set it via env or
      // rely on the OS trust store on the dashboard host.
      method: "GET",
      // Don't follow redirects: a probed target could 30x us toward an
      // internal endpoint (SSRF). A 3xx still counts as "up" below, which is
      // the right semantics for a reachability check anyway.
      redirect: "manual",
    });
    const latencyMs = Date.now() - start;
    const ok = expectedStatus != null ? res.status === expectedStatus : res.status >= 200 && res.status < 400;
    if (!ok) return { ok: false, latencyMs, error: `status ${res.status}` };
    return { ok: true, latencyMs };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: (err as Error).name === "AbortError" ? "timeout" : (err as Error).message,
    };
  } finally {
    clearTimeout(t);
  }
}

async function runTcp(target: string, timeoutMs: number): Promise<CheckResult> {
  const m = /^([^\s:]+):(\d+)$/.exec(target.trim());
  if (!m) return { ok: false, error: 'target must be "host:port"' };
  const host = m[1];
  const port = Number(m[2]);

  const start = Date.now();
  return await new Promise<CheckResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    socket.once("error", (err) => finish({ ok: false, error: err.message }));
    socket.connect(port, host, () => finish({ ok: true, latencyMs: Date.now() - start }));
  });
}

async function runPing(host: string, timeoutMs: number): Promise<CheckResult> {
  // Refuse anything that isn't a bare hostname/IP, and never let it start with
  // '-' so it can't be parsed as a ping flag (e.g. "-f" flood). We pass argv
  // via execFile — no shell — so this regex is belt-and-braces.
  if (!/^[\w.][\w.\-:]*$/.test(host)) return { ok: false, error: "invalid host" };
  const isWin = process.platform === "win32";
  // Linux/macOS: -c 1 (count), -W timeout. macOS uses seconds; Linux too.
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = isWin
    ? ["-n", "1", "-w", String(timeoutMs), host]
    : ["-c", "1", "-W", String(sec), host];
  const start = Date.now();
  try {
    await execFileAsync("ping", args, { timeout: timeoutMs + 1000 });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message.split("\n")[0] };
  }
}

/**
 * Find checks that are due now (based on intervalSeconds vs lastCheckedAt)
 * and probe them. Updates the row with the result and emits an alert when
 * the consecutive-down counter crosses the threshold, or resolves one when
 * the service recovers.
 */
export async function runDueChecks(): Promise<{ ran: number; flipped: number }> {
  const now = new Date();
  const candidates = await prisma.healthCheck.findMany({
    where: { enabled: true },
  });

  let ran = 0;
  let flipped = 0;

  for (const c of candidates) {
    if (c.lastCheckedAt) {
      const due = c.lastCheckedAt.getTime() + c.intervalSeconds * 1000;
      if (due > now.getTime()) continue;
    }
    ran++;
    const result = await runProbe({
      type: c.type as CheckType,
      target: c.target,
      timeoutMs: c.timeoutMs,
      expectedStatus: c.expectedStatus,
    });

    const prevStatus = c.lastStatus;
    const nextStatus = result.ok ? "up" : "down";
    const consecutiveDown = result.ok ? 0 : c.consecutiveDown + 1;

    const certExpiresAt = result.ok && result.certExpiresAt ? result.certExpiresAt : undefined;

    // History row behind uptime % + the latency graph (pruned by retention).
    await prisma.healthCheckResult.create({
      data: { checkId: c.id, ok: result.ok, latencyMs: result.latencyMs ?? null },
    });

    await prisma.healthCheck.update({
      where: { id: c.id },
      data: {
        lastStatus: nextStatus,
        lastCheckedAt: new Date(),
        lastLatencyMs: result.latencyMs ?? null,
        lastError: result.ok ? null : result.error,
        consecutiveDown,
        // Only overwrite when we actually read a fresh expiry (tls probe that
        // succeeded); a failed probe keeps the last known value.
        ...(certExpiresAt ? { certExpiresAt } : {}),
      },
    });

    // Certificate-expiry alert (tls checks only), independent of up/down: a
    // service can be perfectly reachable while its cert is days from expiring.
    if (c.type === "tls" && certExpiresAt) {
      flipped += await reconcileCertExpiry(c.name, certExpiresAt);
    }

    // Alert lifecycle: open after N consecutive downs, resolve on first up.
    if (!result.ok && consecutiveDown === ALERT_AFTER_CONSECUTIVE && prevStatus !== "down") {
      flipped++;
      const created = await prisma.alert.create({
        data: {
          serverId: null, // health checks are service-scoped, not host-scoped
          type: `healthcheck:${c.type}`,
          severity: "critical",
          message: `Service ${c.name} is DOWN (${result.error})`,
        },
      });
      void notifyAlert({
        type: created.type,
        severity: created.severity,
        message: created.message,
        serverName: c.name,
        createdAt: created.createdAt,
      });
    } else if (result.ok && prevStatus === "down") {
      flipped++;
      await prisma.alert.updateMany({
        where: {
          resolved: false,
          type: { startsWith: "healthcheck:" },
          message: { contains: c.name },
        },
        data: { resolved: true },
      });
    }
  }

  return { ran, flipped };
}

/**
 * Open/upgrade/resolve a "cert-expiring" alert for a tls check based on the
 * days left until the certificate expires. Service-scoped (serverId null),
 * matched by name like the up/down alerts. Returns 1 if it changed state.
 */
async function reconcileCertExpiry(name: string, expiresAt: Date): Promise<number> {
  const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);
  const breaching = daysLeft <= CERT_WARN_DAYS;
  const severity = daysLeft <= CERT_CRIT_DAYS ? "critical" : "warning";

  const open = await prisma.alert.findFirst({
    where: { resolved: false, type: "cert-expiring", message: { contains: name } },
  });

  if (!breaching) {
    if (open) {
      await prisma.alert.update({ where: { id: open.id }, data: { resolved: true } });
      return 1;
    }
    return 0;
  }

  const message =
    daysLeft < 0
      ? `TLS certificate for ${name} has EXPIRED (${-daysLeft}d ago)`
      : `TLS certificate for ${name} expires in ${daysLeft}d`;

  if (!open) {
    const created = await prisma.alert.create({
      data: { serverId: null, type: "cert-expiring", severity, message },
    });
    void notifyAlert({
      type: created.type,
      severity: created.severity,
      message: created.message,
      serverName: name,
      createdAt: created.createdAt,
    });
    return 1;
  }

  // Refresh the message; notify only on a genuine upgrade to critical.
  const upgrade = open.severity !== "critical" && severity === "critical";
  await prisma.alert.update({ where: { id: open.id }, data: { severity, message } });
  if (upgrade) {
    void notifyAlert({ type: "cert-expiring", severity, message, serverName: name, createdAt: open.createdAt });
    return 1;
  }
  return 0;
}
