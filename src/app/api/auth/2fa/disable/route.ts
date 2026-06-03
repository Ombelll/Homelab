import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/authz";
import { verifyTotp, consumeRecoveryCode } from "@/lib/totp";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().min(6).max(20) });

/**
 * Turn 2FA off. Requires a valid current TOTP (or recovery) code so a
 * hijacked session alone can't strip the second factor.
 */
export async function POST(request: Request) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const u = await prisma.user.findUnique({ where: { id: guard.user.id } });
  if (!u?.totpEnabled) return NextResponse.json({ ok: true }); // already off

  const okTotp = u.totpSecret ? verifyTotp(parsed.data.code, u.totpSecret) : false;
  const okRecovery = okTotp ? false : await consumeRecoveryCode(u.id, u.recoveryCodes, parsed.data.code);
  if (!okTotp && !okRecovery) {
    return NextResponse.json({ error: "invalid code" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: u.id },
    data: { totpSecret: null, totpEnabled: false, recoveryCodes: null },
  });
  void recordAudit({ user: guard.user, action: "user.2fa.disable", target: `user:${u.id}` });

  return NextResponse.json({ ok: true });
}
