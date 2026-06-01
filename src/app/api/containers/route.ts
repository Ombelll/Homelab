import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const containers = await prisma.container.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { server: { select: { name: true, hostname: true } } },
  });

  const result = containers.map((c) => ({
    id: c.id,
    dockerId: c.dockerId,
    name: c.name,
    image: c.image,
    status: c.status,
    ports: safeParsePorts(c.ports),
    serverName: c.server.name,
    serverHostname: c.server.hostname,
    updatedAt: c.updatedAt,
  }));

  return NextResponse.json({ containers: result });
}

function safeParsePorts(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
