import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import { requireUser } from "@/lib/authz";
import { SESSION_COOKIE } from "@/lib/session-constants";

export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(8).max(1024),
  signOutOtherSessions: z.boolean().default(true),
});

export async function POST(request: Request) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

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

  if (parsed.data.newPassword === parsed.data.currentPassword) {
    return NextResponse.json(
      { error: "new password must be different from the current one" },
      { status: 400 },
    );
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: guard.user.id },
    select: { id: true, passwordHash: true },
  });
  if (!dbUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ok = await verifyPassword(parsed.data.currentPassword, dbUser.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "current password is incorrect" },
      { status: 401 },
    );
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({
    where: { id: dbUser.id },
    data: { passwordHash: newHash },
  });

  // Optionally invalidate every OTHER session — keeps the current browser
  // signed in but boots anyone else off. The token in the current cookie
  // is needed to identify which session to spare.
  if (parsed.data.signOutOtherSessions) {
    const currentToken = cookies().get(SESSION_COOKIE)?.value;
    const currentTokenHash = currentToken
      ? createHash("sha256").update(currentToken).digest("hex")
      : null;
    await prisma.session.deleteMany({
      where: {
        userId: dbUser.id,
        ...(currentTokenHash ? { NOT: { tokenHash: currentTokenHash } } : {}),
      },
    });
  }

  return NextResponse.json({ ok: true });
}
