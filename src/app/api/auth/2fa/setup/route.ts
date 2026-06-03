import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { requireUser } from "@/lib/authz";
import { generateTotpSecret, totpKeyUri } from "@/lib/totp";

export const dynamic = "force-dynamic";

/**
 * Begin 2FA enrollment: generate a fresh secret and return it + a QR/otpauth
 * URI for the user's authenticator app. Nothing is stored yet — the secret is
 * only persisted once the user proves they have it via /enable.
 */
export async function POST() {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const secret = generateTotpSecret();
  const otpauth = totpKeyUri(guard.user.email, secret);
  const qr = await QRCode.toDataURL(otpauth);
  return NextResponse.json({ secret, otpauth, qr });
}
