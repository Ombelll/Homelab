import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(1024),
});

// Always-fake hash to keep response time roughly equal whether the user
// exists or not. Mitigates user-enumeration timing attacks.
const DUMMY_HASH = "s1$00000000000000000000000000000000$" + "0".repeat(128);

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
  });

  // Run scrypt either way (against the dummy if the user is missing) so
  // login and "no such user" take the same wall-clock time.
  const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const { token, expiresAt } = await createSession(user.id);
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return NextResponse.json({ ok: true });
}
