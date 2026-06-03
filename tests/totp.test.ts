import { describe, it, expect } from "vitest";
import { authenticator } from "otplib";
import { verifyTotp, generateTotpSecret, generateRecoveryCodes, hashRecoveryCode } from "@/lib/totp";

describe("totp", () => {
  it("accepts a freshly generated code and rejects wrong ones", () => {
    const secret = generateTotpSecret();
    const good = authenticator.generate(secret);
    expect(verifyTotp(good, secret)).toBe(true);
    expect(verifyTotp("000000", secret)).toBe(false);
    expect(verifyTotp("abc", secret)).toBe(false);
    expect(verifyTotp("", secret)).toBe(false);
  });
  it("recovery codes are 10 unique hex strings, hashing is stable", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(codes[0].toUpperCase()));
    expect(hashRecoveryCode(codes[0])).not.toBe(hashRecoveryCode(codes[1]));
  });
});
