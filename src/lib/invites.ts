import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createInvite(input: {
  createdByUserId: string;
  emailHint?: string;
  role?: "admin" | "viewer";
  ttlMs?: number;
}) {
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS));
  const record = await prisma.invite.create({
    data: {
      tokenHash: hashInviteToken(token),
      emailHint: input.emailHint?.toLowerCase() || null,
      role: input.role ?? "viewer",
      expiresAt,
      createdByUserId: input.createdByUserId,
    },
    select: { id: true, emailHint: true, role: true, expiresAt: true, createdAt: true },
  });
  return { ...record, token };
}

type InviteRecord = NonNullable<Awaited<ReturnType<typeof prisma.invite.findUnique>>>;
export type ConsumeResult =
  | { ok: true; invite: InviteRecord }
  | { ok: false; reason: "unknown" | "used" | "expired" };

export async function consumeInvite(rawToken: string): Promise<ConsumeResult> {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashInviteToken(rawToken) },
  });
  if (!invite) return { ok: false, reason: "unknown" };
  if (invite.usedAt) return { ok: false, reason: "used" };
  if (invite.expiresAt < new Date()) return { ok: false, reason: "expired" };
  return { ok: true, invite };
}

export async function markInviteUsed(id: string) {
  await prisma.invite.update({ where: { id }, data: { usedAt: new Date() } });
}
