import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE } from "@/lib/session-constants";

export { SESSION_COOKIE };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Create a session for `userId`. Returns the raw token; caller is responsible
 * for setting it on the cookie. We only ever store the hash in the DB so a
 * read of the Session table cannot be replayed against the API.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

export async function destroySessionByToken(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export type UserRole = "admin" | "viewer";
export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

/**
 * Resolve the currently-signed-in user from the request cookies. Returns null
 * if the cookie is missing, the session doesn't exist, or it's expired. Also
 * lazily deletes the row if it's expired.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookie = cookies().get(SESSION_COOKIE);
  if (!cookie?.value) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(cookie.value) },
    include: { user: { select: { id: true, email: true, name: true, role: true } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return { ...session.user, role: normalizeRole(session.user.role) };
}

function normalizeRole(raw: string | null | undefined): UserRole {
  return raw === "admin" ? "admin" : "viewer";
}

export async function countUsers(): Promise<number> {
  return prisma.user.count();
}

export function sessionCookieOptions(expiresAt?: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}
