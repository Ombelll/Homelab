import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
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

/**
 * Atomically claim a single-use invite by token, in ONE conditional UPDATE
 * gated on `usedAt IS NULL AND not-yet-expired`. Returns true only for the
 * caller whose statement actually flipped the row (affected-row count === 1);
 * every concurrent redemption of the same token gets false.
 *
 * This is what makes a single-use invite truly single-use. The read-only
 * consumeInvite() has a check-then-act window — two concurrent requests can
 * both pass its `usedAt` check and go on to create two accounts (potentially
 * two admins) from one token. The single UPDATE here has no such window.
 *
 * Pass a transaction client (`tx`) to claim inside a larger transaction, so
 * the claim rolls back if a later step (e.g. user creation) fails and the
 * invite stays usable.
 */
export async function claimInviteByToken(
  rawToken: string,
  client: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const res = await client.invite.updateMany({
    where: { tokenHash: hashInviteToken(rawToken), usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return res.count === 1;
}
