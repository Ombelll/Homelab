import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Placeholder — real implementation will request logs from the host agent
// (which has the Docker socket / equivalent permissions). See AGENTS.md.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const container = await prisma.container.findUnique({ where: { id: params.id } });
  if (!container) return NextResponse.json({ error: "not found" }, { status: 404 });

  const lines = [
    `[${new Date().toISOString()}] (mock) container ${container.name} (${container.image}) is ${container.status}`,
    "[mock] real log streaming will be added once the agent gains a command channel.",
  ];
  return NextResponse.json({ container: container.name, lines });
}
