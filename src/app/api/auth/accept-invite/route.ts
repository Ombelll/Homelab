import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/lib/session";
import { consumeInvite, markInviteUsed } from "@/lib/invites";

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

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await prisma.user.create({
    data: { email, name: parsed.data.name?.trim() || null, passwordHash },
  });

  await markInviteUsed(result.invite.id);

  const { token, expiresAt } = await createSession(user.id);
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return NextResponse.json({ ok: true });
}
