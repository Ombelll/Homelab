import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";

// Canonical action names. Keep them dot-separated and stable so older log
// entries stay queryable when we add new ones.
export const AUDIT_ACTIONS = [
  "user.create",
  "user.update",
  "user.delete",
  "user.password.change",
  "agent-key.create",
  "agent-key.revoke",
  "invite.create",
  "invite.revoke",
  "channel.create",
  "channel.update",
  "channel.delete",
  "channel.test",
  "healthcheck.create",
  "healthcheck.update",
  "healthcheck.delete",
  "container.start",
  "container.stop",
  "container.restart",
  "container.logs",
  "container.logs.stream",
  "alert.ack",
  "alert.snooze",
  "alert.resolve",
  "maintenance.create",
  "maintenance.delete",
  "server.update",
  "server.wake",
  "agent.update",
  "backup.export",
  "backup.restore",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Append an audit log entry. Never throws — failure to log must not block
 * the action itself. We capture the IP via the standard X-Forwarded-For
 * fallback chain so reverse-proxied deployments still record the real
 * client address.
 */
export async function recordAudit(input: {
  user?: Pick<CurrentUser, "id" | "email"> | null;
  action: AuditAction;
  target?: string;
  metadata?: unknown;
}): Promise<void> {
  try {
    const h = headers();
    const ip =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null;

    await prisma.auditLog.create({
      data: {
        userId: input.user?.id ?? null,
        actorEmail: input.user?.email ?? null,
        action: input.action,
        target: input.target ?? null,
        metadata: input.metadata == null ? null : JSON.stringify(input.metadata),
        ip,
      },
    });
  } catch (err) {
    // Audit failures are visible only to the operator (server logs); the
    // action itself proceeds.
    console.warn("[audit] failed to record:", (err as Error).message);
  }
}
