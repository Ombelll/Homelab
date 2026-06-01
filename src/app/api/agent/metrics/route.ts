import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { metricsSchema } from "@/lib/validation";
import { evaluateMetricAlerts } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await verifyAgentKey(request))) return unauthorized();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = metricsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { hostname, cpuPercent, memoryPercent, diskPercent } = parsed.data;

  const server = await prisma.server.findUnique({ where: { hostname } });
  if (!server) {
    return NextResponse.json(
      { error: "unknown server, call /api/agent/checkin first" },
      { status: 404 },
    );
  }

  const metric = await prisma.metric.create({
    data: { serverId: server.id, cpuPercent, memoryPercent, diskPercent },
  });

  // Compute a coarse status from latest metrics so the dashboard reflects
  // resource pressure without a separate alert engine in MVP.
  const status = deriveStatus(cpuPercent, memoryPercent, diskPercent);

  await prisma.server.update({
    where: { id: server.id },
    data: { status, lastSeenAt: new Date() },
  });

  await evaluateMetricAlerts({
    serverId: server.id,
    serverName: server.name,
    cpuPercent,
    memoryPercent,
    diskPercent,
  });

  return NextResponse.json({ ok: true, metricId: metric.id, status });
}

function deriveStatus(cpu: number, mem: number, disk: number) {
  if (cpu >= 95 || mem >= 95 || disk >= 95) return "critical";
  if (cpu >= 80 || mem >= 85 || disk >= 85) return "warning";
  return "online";
}
