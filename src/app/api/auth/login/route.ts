import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/lib/session";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { verifyTotp, consumeRecoveryCode } from "@/lib/totp";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(1024),
  // Optional second factor — only required for accounts with 2FA enabled.
  code: z.string().max(20).optional(),
});

// Always-fake hash to keep response time roughly equal whether the user
// exists or not. Mitigates user-enumeration timing attacks.
const DUMMY_HASH = "s1$00000000000000000000000000000000$" + "0".repeat(128);

// 5 login attempts per IP per minute. Low enough to make brute-force
// useless, high enough to forgive the "wait, was it horseBattery or
// HorseBattery" round of fumbling.
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60 * 1000;

export async function POST(request: Request) {
  const ip = clientIp(request.headers);
  const limit = rateLimit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!limit.ok) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: "too many login attempts, slow down" },
      {
        status: 429,
        headers: { "retry-after": String(retryAfter) },
      },
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

  // Second factor — only for accounts that opted in (totpEnabled). Accounts
  // without 2FA log in exactly as before.
  if (user.totpEnabled) {
    const code = parsed.data.code?.trim();
    if (!code) {
      // Password was correct; the UI should now prompt for the 2FA code.
      return NextResponse.json({ error: "2fa required", twoFactor: true }, { status: 401 });
    }
    const okTotp = user.totpSecret ? verifyTotp(code, user.totpSecret) : false;
    const okRecovery = okTotp ? false : await consumeRecoveryCode(user.id, user.recoveryCodes, code);
    if (!okTotp && !okRecovery) {
      return NextResponse.json({ error: "invalid 2FA code", twoFactor: true }, { status: 401 });
    }
  }

  const { token, expiresAt } = await createSession(user.id);
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return NextResponse.json({ ok: true });
}
