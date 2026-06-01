import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt parameters. N=2^15 ≈ ~50ms on modern hardware. Increase if you can
// tolerate slower login; do not decrease.
//
// MAXMEM: scrypt's memory cost is ~128*N*r bytes. At N=2^15 / r=8 that's
// ~33 MiB, just over Node's 32 MiB default which makes scrypt throw
// "memory limit exceeded". 64 MiB gives us headroom now and if we ever
// bump N to 2^16.
const N = 1 << 15;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;

/**
 * Promise wrapper for scrypt with options. We don't use `util.promisify`
 * here because its overload resolution picks the 3-argument signature, and
 * we need to pass the 4th `options` arg.
 */
function scryptWithOptions(
  password: Buffer | string,
  salt: Buffer,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, maxmem: MAXMEM }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Hash a plaintext password. Output format: `s1$<saltHex>$<hashHex>`.
 * The "s1" prefix lets us migrate to a different KDF later without
 * invalidating existing hashes.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptWithOptions(plaintext, salt, KEY_LEN);
  return `s1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = await scryptWithOptions(plaintext, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
