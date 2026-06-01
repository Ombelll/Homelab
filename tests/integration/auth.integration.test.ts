import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import { hashInviteToken, createInvite, consumeInvite, markInviteUsed } from "@/lib/invites";

/**
 * End-to-end auth flows: registration via invite, password verify path,
 * and invite-token single-use behaviour. These are the bits where a bug
 * silently locks people out, so they get integration coverage on top of
 * unit tests.
 */

async function reset() {
  await prisma.$transaction([
    prisma.invite.deleteMany(),
    prisma.session.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

describe("auth (integration)", () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("hashes + verifies a password round-trip", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    const user = await prisma.user.create({
      data: { email: "alice@example.com", passwordHash: hash, role: "admin" },
    });

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbUser).not.toBeNull();
    expect(await verifyPassword("correct-horse-battery-staple", dbUser!.passwordHash)).toBe(true);
    expect(await verifyPassword("WRONG", dbUser!.passwordHash)).toBe(false);
  });

  it("rejects a consumed invite the second time", async () => {
    const admin = await prisma.user.create({
      data: {
        email: "admin@example.com",
        passwordHash: await hashPassword("hunter22"),
        role: "admin",
      },
    });

    const invite = await createInvite({
      createdByUserId: admin.id,
      emailHint: "viewer@example.com",
      role: "viewer",
    });

    const first = await consumeInvite(invite.token);
    expect(first.ok).toBe(true);
    if (first.ok) {
      await markInviteUsed(first.invite.id);
    }

    const second = await consumeInvite(invite.token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("used");
  });

  it("rejects an expired invite", async () => {
    const admin = await prisma.user.create({
      data: {
        email: "admin2@example.com",
        passwordHash: await hashPassword("hunter22"),
        role: "admin",
      },
    });

    // Create normally, then back-date so it counts as expired.
    const invite = await createInvite({ createdByUserId: admin.id });
    await prisma.invite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await consumeInvite(invite.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("only stores the SHA-256 hash of the invite token", async () => {
    const admin = await prisma.user.create({
      data: {
        email: "admin3@example.com",
        passwordHash: await hashPassword("hunter22"),
        role: "admin",
      },
    });
    const invite = await createInvite({ createdByUserId: admin.id });

    const row = await prisma.invite.findUnique({ where: { id: invite.id } });
    expect(row!.tokenHash).toBe(hashInviteToken(invite.token));
    expect(row!.tokenHash).not.toBe(invite.token); // raw token never leaks to DB
  });
});
