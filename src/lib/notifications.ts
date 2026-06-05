import { z } from "zod";
import nodemailer from "nodemailer";
import { prisma } from "@/lib/prisma";

export const CHANNEL_TYPES = ["discord", "ntfy", "webhook", "smtp"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export const discordConfigSchema = z.object({
  webhookUrl: z.string().url(),
});

export const ntfyConfigSchema = z.object({
  server: z.string().url().default("https://ntfy.sh"),
  topic: z.string().min(1).max(255),
  token: z.string().optional(),
});

export const webhookConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const smtpConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  // STARTTLS on 587 is the most common; flip to true for SMTPS on 465.
  secure: z.boolean().default(false),
  user: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
  from: z.string().min(3).max(255),
  to: z.string().min(3).max(255),
});

export function validateChannelConfig(
  type: ChannelType,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema =
    type === "discord"
      ? discordConfigSchema
      : type === "ntfy"
      ? ntfyConfigSchema
      : type === "webhook"
      ? webhookConfigSchema
      : smtpConfigSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    return { ok: false, error: msg };
  }
  return { ok: true, value: parsed.data };
}

export type AlertNotification = {
  type: string;
  severity: string;
  message: string;
  serverName: string | null;
  createdAt: Date;
};

/**
 * Quiet hours: during the window set by QUIET_HOURS_START/END ("HH:MM", local
 * time, may wrap midnight) only `critical` alerts are pushed — warnings/info
 * are still recorded as alerts, just not sent until the window ends. Lets you
 * sleep without a 3am ntfy buzz for a transient warning. Unset = always notify.
 */
export function inQuietHours(now: Date = new Date()): boolean {
  const start = process.env.QUIET_HOURS_START?.trim();
  const end = process.env.QUIET_HOURS_END?.trim();
  if (!start || !end) return false;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

const SECRET_KEYS = new Set(["webhookUrl", "token", "url", "headers", "password"]);

/**
 * Strip secrets out of a channel config before sending it to the UI.
 * URLs are redacted to their host; tokens are replaced with a fixed marker.
 */
export function redactConfig(type: ChannelType, raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SECRET_KEYS.has(k)) {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      try {
        const u = new URL(v);
        out[k] = `${u.protocol}//${u.host}/…`;
      } catch {
        out[k] = "***";
      }
    } else if (v && typeof v === "object") {
      out[k] = "*** (set)";
    } else {
      out[k] = v;
    }
  }
  // Always echo a "secretSet" boolean so the UI can render a "rotate" prompt.
  if (type === "discord") out.secretSet = "webhookUrl" in (raw as object);
  if (type === "ntfy") out.secretSet = "token" in (raw as object);
  if (type === "webhook") out.secretSet = "url" in (raw as object);
  if (type === "smtp") out.secretSet = "password" in (raw as object);
  return out;
}

/**
 * Fire-and-forget notification for an alert. Failures are recorded on the
 * channel row (lastError) and never propagate — alerting must not block the
 * metrics ingest path.
 */
export async function notifyAlert(alert: AlertNotification): Promise<void> {
  // During quiet hours, only critical alerts are pushed. The alert row is
  // already persisted by the caller — we only suppress the outbound notify.
  if (inQuietHours() && (SEVERITY_RANK[alert.severity] ?? 0) < SEVERITY_RANK.critical) {
    return;
  }

  const channels = await prisma.notificationChannel.findMany({
    where: { enabled: true },
  });

  await Promise.all(
    channels.map(async (c) => {
      const minRank = SEVERITY_RANK[c.minSeverity] ?? SEVERITY_RANK.warning;
      const alertRank = SEVERITY_RANK[alert.severity] ?? 0;
      if (alertRank < minRank) return;

      try {
        const config = JSON.parse(c.config || "{}");
        await sendToChannel(c.type as ChannelType, config, alert);
        await prisma.notificationChannel.update({
          where: { id: c.id },
          data: { lastUsedAt: new Date(), lastError: null },
        });
      } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? "unknown";
        await prisma.notificationChannel
          .update({
            where: { id: c.id },
            data: { lastUsedAt: new Date(), lastError: message },
          })
          .catch(() => {});
        // Swallow — never let a broken webhook take down the API.
        console.warn(`[notify] channel ${c.name} failed: ${message}`);
      }
    }),
  );
}

/**
 * "Who watches the watcher" — send a low-priority test notification to every
 * enabled channel and report how many actually delivered. A scheduled caller
 * pings a healthchecks.io dead-man's switch ONLY when at least one delivered;
 * if the whole alerting path is silently broken, that ping is skipped and the
 * dead-man fires through a *different* channel (email). Bypasses minSeverity /
 * quiet-hours on purpose — it's testing the pipe, not raising an alert.
 */
export async function sendHeartbeat(): Promise<{ sent: number; failed: number; total: number }> {
  const channels = await prisma.notificationChannel.findMany({ where: { enabled: true } });
  const alert: AlertNotification = {
    type: "heartbeat",
    severity: "info",
    message: "✅ Alerting-path heartbeat — notifications are working (weekly self-test).",
    serverName: "monitoring",
    createdAt: new Date(),
  };
  let sent = 0;
  let failed = 0;
  for (const c of channels) {
    try {
      await sendToChannel(c.type as ChannelType, JSON.parse(c.config || "{}"), alert);
      sent++;
      await prisma.notificationChannel
        .update({ where: { id: c.id }, data: { lastUsedAt: new Date(), lastError: null } })
        .catch(() => {});
    } catch (err) {
      failed++;
      await prisma.notificationChannel
        .update({ where: { id: c.id }, data: { lastError: (err as Error).message?.slice(0, 500) ?? "unknown" } })
        .catch(() => {});
    }
  }
  return { sent, failed, total: channels.length };
}

export async function sendToChannel(
  type: ChannelType,
  rawConfig: unknown,
  alert: AlertNotification,
): Promise<void> {
  switch (type) {
    case "discord": {
      const cfg = discordConfigSchema.parse(rawConfig);
      const color = alert.severity === "critical" ? 0xdc2626 : alert.severity === "warning" ? 0xf59e0b : 0x3b82f6;
      await postJson(cfg.webhookUrl, {
        embeds: [
          {
            title: `[${alert.severity.toUpperCase()}] ${alert.serverName ?? "system"}`,
            description: alert.message,
            color,
            timestamp: alert.createdAt.toISOString(),
            footer: { text: `Homelab Control Center · ${alert.type}` },
          },
        ],
      });
      return;
    }
    case "ntfy": {
      const cfg = ntfyConfigSchema.parse(rawConfig);
      const headers: Record<string, string> = {
        Title: `[${alert.severity}] ${alert.serverName ?? "system"}`,
        Priority: alert.severity === "critical" ? "5" : alert.severity === "warning" ? "4" : "3",
        Tags: alert.severity === "critical" ? "rotating_light" : "warning",
      };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      const res = await fetch(`${cfg.server.replace(/\/+$/, "")}/${encodeURIComponent(cfg.topic)}`, {
        method: "POST",
        headers,
        body: alert.message,
      });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
      return;
    }
    case "webhook": {
      const cfg = webhookConfigSchema.parse(rawConfig);
      await postJson(cfg.url, {
        severity: alert.severity,
        type: alert.type,
        server: alert.serverName,
        message: alert.message,
        at: alert.createdAt.toISOString(),
      }, cfg.headers);
      return;
    }
    case "smtp": {
      const cfg = smtpConfigSchema.parse(rawConfig);
      const transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.password },
      });
      const subject = `[${alert.severity.toUpperCase()}] ${alert.serverName ?? "system"} · ${alert.type}`;
      const text = [
        alert.message,
        "",
        `Server: ${alert.serverName ?? "system"}`,
        `Type: ${alert.type}`,
        `Severity: ${alert.severity}`,
        `When: ${alert.createdAt.toISOString()}`,
        "",
        "— Homelab Control Center",
      ].join("\n");
      await transporter.sendMail({
        from: cfg.from,
        to: cfg.to,
        subject,
        text,
      });
      return;
    }
  }
}

async function postJson(url: string, body: unknown, extraHeaders?: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}
