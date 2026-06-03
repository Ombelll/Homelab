import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/authz";
import { verifyTotp, generateRecoveryCodes, hashRecoveryCode } from "@/lib/totp";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  secret: z.string().min(16).max(128),
  code: z.string().min(6).max(10),
});

/**
 * Finish enrollment: verify a live code against the pending secret, and only
 * then store the secret + flip totpEnabled. Returns one-time recovery codes
 * (plaintext, shown exactly once). Verify-before-store means a user can never
 * lock themselves out with a mistyped/desynced secret.
 */
export async function POST(request: Request) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }
  if (!verifyTotp(parsed.data.code, parsed.data.secret)) {
    return NextResponse.json(
      { error: "code didn't match — check the time on your phone and try again" },
      { status: 400 },
    );
  }

  const recoveryCodes = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: guard.user.id },
    data: {
      totpSecret: parsed.data.secret,
      totpEnabled: true,
      recoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
    },
  });
  void recordAudit({ user: guard.user, action: "user.2fa.enable", target: `user:${guard.user.id}` });

  return NextResponse.json({ ok: true, recoveryCodes });
}
