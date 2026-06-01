import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

// scrypt parameters. N=2^15 ≈ ~50ms on modern hardware. Increase if you can
// tolerate slower login; do not decrease.
const N = 1 << 15;
const KEY_LEN = 64;
const SALT_LEN = 16;

/**
 * Hash a plaintext password. Output format: `s1$<saltHex>$<hashHex>`.
 * The "s1" prefix lets us migrate to a different KDF later without
 * invalidating existing hashes.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = (await scryptAsync(plaintext, salt, KEY_LEN, { N })) as Buffer;
  return `s1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = (await scryptAsync(plaintext, salt, expected.length, { N })) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
