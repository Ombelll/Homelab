import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";

describe("password hashing", () => {
  it("round-trips a correct password", async () => {
    const stored = await hashPassword("hunter2-correct-horse");
    expect(stored).toMatch(/^s1\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifyPassword("hunter2-correct-horse", stored)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const stored = await hashPassword("hunter2");
    expect(await verifyPassword("hunter3", stored)).toBe(false);
  });

  it("produces a different hash for the same password (salted)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("anything", "s2$aa$bb")).toBe(false);
  });
}, 30_000);
