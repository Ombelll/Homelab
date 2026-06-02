import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/lib/session";
import { consumeInvite, claimInviteByToken } from "@/lib/invites";

export const dynamic = "force-dynamic";

// Thrown inside the claim+create transaction when the atomic claim loses the
// race to a concurrent redemption (or the token expired between the read-only
// pre-check and the UPDATE). Caught below to roll the transaction back and
// return a 400 instead of minting a second account.
class InviteUnavailableError extends Error {}

const schema = z.object({
  token: z.string().min(1).max(256),
  email: z.string().email().max(255),
  name: z.string().max(255).optional(),
  password: z.string().min(8).max(1024),
});

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Read-only pre-check, purely so we can return the precise reason
  // (unknown / used / expired) for a clean error. It is NOT the single-use
  // guarantee — that comes from the atomic claim in the transaction below.
  const pre = await consumeInvite(parsed.data.token);
  if (!pre.ok) {
    return NextResponse.json({ error: `invite ${pre.reason}` }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "email already in use" }, { status: 409 });
  }

  // Hash before opening the transaction — scrypt is deliberately slow and we
  // don't want to hold a write transaction open across it.
  const passwordHash = await hashPassword(parsed.data.password);
  const role = pre.invite.role === "admin" ? "admin" : "viewer";

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      // Atomic claim: flips usedAt only if still null AND unexpired. If a
      // concurrent request already won, this affects 0 rows — we abort the
      // transaction so no second account is created from one invite.
      const claimed = await claimInviteByToken(parsed.data.token, tx);
      if (!claimed) throw new InviteUnavailableError();

      // If this create throws (e.g. the email was taken in a race after the
      // pre-check), the whole transaction — including the claim — rolls back,
      // leaving the invite usable.
      return tx.user.create({
        data: {
          email,
          name: parsed.data.name?.trim() || null,
          passwordHash,
          role,
        },
      });
    });
  } catch (err) {
    if (err instanceof InviteUnavailableError) {
      return NextResponse.json({ error: "invite used" }, { status: 400 });
    }
    // Unique-constraint violation on email (concurrent signup, same address).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "email already in use" }, { status: 409 });
    }
    throw err;
  }

  const { token, expiresAt } = await createSession(user.id);
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return NextResponse.json({ ok: true });
}
