import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs";

/**
 * Verifies the duplicate-enqueue collapse contract: clicking "stop" five
 * times in a row should result in a single pending job for that container,
 * not five.
 */

async function reset() {
  await prisma.$transaction([
    prisma.job.deleteMany(),
    prisma.server.deleteMany(),
  ]);
}

describe("enqueueJob dedupe (integration)", () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("collapses identical pending jobs into one", async () => {
    const s = await prisma.server.create({
      data: { name: "alpha", hostname: `alpha-${Date.now()}.test`, status: "online" },
    });

    const a = await enqueueJob({
      serverId: s.id,
      type: "container.stop",
      payload: { dockerId: "abc123" },
    });
    const b = await enqueueJob({
      serverId: s.id,
      type: "container.stop",
      payload: { dockerId: "abc123" },
    });
    const c = await enqueueJob({
      serverId: s.id,
      type: "container.stop",
      payload: { dockerId: "abc123" },
    });

    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);

    const all = await prisma.job.findMany({ where: { serverId: s.id } });
    expect(all).toHaveLength(1);
  });

  it("does NOT collapse jobs with different payloads", async () => {
    const s = await prisma.server.create({
      data: { name: "alpha", hostname: `alpha-${Date.now()}.test`, status: "online" },
    });

    await enqueueJob({ serverId: s.id, type: "container.stop", payload: { dockerId: "a" } });
    await enqueueJob({ serverId: s.id, type: "container.stop", payload: { dockerId: "b" } });

    const all = await prisma.job.findMany({ where: { serverId: s.id } });
    expect(all).toHaveLength(2);
  });

  it("enqueues a new job after the previous one moved to done", async () => {
    const s = await prisma.server.create({
      data: { name: "alpha", hostname: `alpha-${Date.now()}.test`, status: "online" },
    });

    const first = await enqueueJob({
      serverId: s.id,
      type: "container.restart",
      payload: { dockerId: "x" },
    });
    await prisma.job.update({
      where: { id: first.id },
      data: { status: "done", completedAt: new Date() },
    });

    const second = await enqueueJob({
      serverId: s.id,
      type: "container.restart",
      payload: { dockerId: "x" },
    });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
  });
});
