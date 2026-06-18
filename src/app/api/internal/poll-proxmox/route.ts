import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkSweepKey } from "@/lib/sweep-auth";
import { collectProxmox } from "@/lib/proxmox";
import { notifyAlert } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * Poll the Proxmox cluster (read-only) and upsert nodes + guests. Same SWEEP_KEY
 * guard as the other internal routes. Recommended cadence (every minute):
 *
 *   * * * * * curl -fsS -X POST http://dashboard/api/internal/poll-proxmox \
 *               -H "x-sweep-key: $SWEEP_KEY" > /dev/null
 *
 * No-op (configured:false) until PROXMOX_API_URL / PROXMOX_TOKEN_ID /
 * PROXMOX_TOKEN_SECRET are set. Read-only: never issues lifecycle actions.
 */
export async function POST(request: Request) {
  const denied = checkSweepKey(request);
  if (denied) return denied;

  let data;
  try {
    data = await collectProxmox();
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
  if (!data) return NextResponse.json({ ok: true, configured: false });

  const now = new Date();

  // Nodes first (guests FK-reference them by name) — upsert, never delete.
  for (const n of data.nodes) {
    if (!n.node) continue;
    const fields = {
      status: n.status,
      cpu: n.cpu,
      maxCpu: n.maxCpu,
      memUsedMb: n.memUsedMb,
      memTotalMb: n.memTotalMb,
      uptimeSec: n.uptimeSec,
      level: n.level,
      lastSeenAt: now,
    };
    await prisma.proxmoxNode.upsert({
      where: { node: n.node },
      update: fields,
      create: { node: n.node, ...fields },
    });
  }

  // Guests — upsert each, then delete any that vanished from the cluster.
  for (const g of data.guests) {
    if (!g.node) continue;
    const fields = {
      type: g.type,
      name: g.name,
      nodeName: g.node,
      status: g.status,
      cpu: g.cpu,
      maxCpu: g.maxCpu,
      memUsedMb: g.memUsedMb,
      maxMemMb: g.maxMemMb,
      diskUsedMb: g.diskUsedMb,
      maxDiskMb: g.maxDiskMb,
      uptimeSec: g.uptimeSec,
      template: g.template,
      tags: g.tags,
      lastSeenAt: now,
    };
    await prisma.proxmoxGuest.upsert({
      where: { vmid: g.vmid },
      update: fields,
      create: { vmid: g.vmid, ...fields },
    });
  }
  const seenVmids = data.guests.map((g) => g.vmid);
  const removed = await prisma.proxmoxGuest.deleteMany({
    where: { vmid: { notIn: seenVmids.length ? seenVmids : [-1] } },
  });

  // One open/resolve alert per node that's offline in the cluster status.
  let alertsOpened = 0;
  let alertsCleared = 0;
  for (const n of data.nodes) {
    const changed = await reconcileNodeAlert(n.node, n.status !== "online");
    if (changed === "opened") alertsOpened++;
    else if (changed === "cleared") alertsCleared++;
  }

  return NextResponse.json({
    ok: true,
    configured: true,
    nodes: data.nodes.length,
    guests: data.guests.length,
    removedGuests: removed.count,
    alertsOpened,
    alertsCleared,
  });
}

// Open a service-scoped alert (serverId null) when a node is offline, resolve it
// when it's back — mirrors the router route's reconcile, keyed on the node name.
async function reconcileNodeAlert(
  node: string,
  bad: boolean,
): Promise<"opened" | "cleared" | null> {
  const type = "proxmox-node-down";
  const message = `Proxmox node ${node} is offline`;
  const open = await prisma.alert.findFirst({
    where: { resolved: false, type, message: { contains: node } },
  });
  if (bad) {
    if (open) return null;
    const created = await prisma.alert.create({
      data: { serverId: null, type, severity: "critical", message },
    });
    void notifyAlert({
      type: created.type,
      severity: created.severity,
      message: created.message,
      serverName: node,
      createdAt: created.createdAt,
    });
    return "opened";
  }
  if (open) {
    await prisma.alert.update({
      where: { id: open.id },
      data: { resolved: true, resolvedAt: new Date() },
    });
    return "cleared";
  }
  return null;
}
