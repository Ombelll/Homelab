import { authenticator } from "otplib";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Allow ±1 time-step (30s) of clock drift between the server and the phone.
authenticator.options = { window: 1 };

const SERVICE = "Homelab Control Center";

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/** otpauth:// URI for QR codes / manual entry into an authenticator app. */
export function totpKeyUri(account: string, secret: string): string {
  return authenticator.keyuri(account, SERVICE, secret);
}

export function verifyTotp(token: string, secret: string): boolean {
  const t = (token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  try {
    return authenticator.verify({ token: t, secret });
  } catch {
    return false;
  }
}

/** One-time backup codes — shown once at enable, then only their hashes stored. */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => randomBytes(5).toString("hex")); // 10 hex chars
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

/**
 * Verify a recovery code against the user's stored (hashed) set and, if it
 * matches, consume it (remove so it can't be reused). Returns true on a
 * successful single-use redemption.
 */
export async function consumeRecoveryCode(
  userId: string,
  storedJson: string | null | undefined,
  code: string,
): Promise<boolean> {
  if (!storedJson) return false;
  let hashes: string[];
  try {
    hashes = JSON.parse(storedJson);
  } catch {
    return false;
  }
  const h = hashRecoveryCode(code);
  if (!hashes.includes(h)) return false;
  const remaining = hashes.filter((x) => x !== h);
  await prisma.user.update({
    where: { id: userId },
    data: { recoveryCodes: JSON.stringify(remaining) },
  });
  return true;
}
