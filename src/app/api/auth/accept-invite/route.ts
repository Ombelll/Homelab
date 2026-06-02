import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/lib/session";
import { consumeInvite, claimInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

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

  const result = await consumeInvite(parsed.data.token);
  if (!result.ok) {
    return NextResponse.json({ error: `invite ${result.reason}` }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "email already in use" }, { status: 409 });
  }

  // Atomically claim the invite BEFORE creating the account. If a concurrent
  // request already claimed this token, we lose the race and stop — so one
  // single-use invite can never mint two accounts.
  if (!(await claimInvite(result.invite.id))) {
    return NextResponse.json({ error: "invite used" }, { status: 400 });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  let user;
  try {
    user = await prisma.user.create({
      data: {
        email,
        name: parsed.data.name?.trim() || null,
        passwordHash,
        role: result.invite.role === "admin" ? "admin" : "viewer",
      },
    });
  } catch {
    // Unique-constraint race on email (two signups, same address). The invite
    // is already spent; surface a clean conflict.
    return NextResponse.json({ error: "email already in use" }, { status: 409 });
  }

  const { token, expiresAt } = await createSession(user.id);
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return NextResponse.json({ ok: true });
}
