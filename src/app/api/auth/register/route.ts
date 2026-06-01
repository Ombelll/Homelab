import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { SESSION_COOKIE, createSession, countUsers, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(255),
  name: z.string().max(255).optional(),
  password: z.string().min(8).max(1024),
});

/**
 * Bootstrap-only registration: succeeds only when the User table is empty.
 * Subsequent users must be invited (UI for that is on the roadmap).
 */
export async function POST(request: Request) {
  if ((await countUsers()) > 0) {
    return NextResponse.json(
      { error: "registration disabled; an admin already exists" },
      { status: 403 },
    );
  }

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

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await prisma.user.create({
    data: {
      email: parsed.data.email.toLowerCase(),
      name: parsed.data.name?.trim() || null,
      passwordHash,
    },
  });

  const { token, expiresAt } = await createSession(user.id);
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return NextResponse.json({ ok: true });
}
