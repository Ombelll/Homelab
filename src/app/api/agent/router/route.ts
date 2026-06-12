import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { unauthorized, verifyAgentKey } from "@/lib/auth";
import { routerReportSchema } from "@/lib/validation";
import { notifyAlert } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// SoC temperature we consider worth a warning. The MT7981 idles ~60-70 °C and
// runs warm under load; >90 °C is a real "something's wrong / no airflow" signal.
const TEMP_WARN_C = 90;

/**
 * Ingest an SSH poll of an OpenWrt/GL.iNet router from an agent. Unlike the
 * SNMP switch path (per-port), a router reports host-style stats (temp, mem,
 * load, WAN up/throughput, client count). We upsert it as a NetworkDevice with
 * kind="router" and store WAN throughput as a NetworkDeviceSample for the spark.
 *
 * Auth: shared agent key. The "host" in the body is the polled router, not the
 * reporting agent — no hostname binding.
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = routerReportSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!(await verifyAgentKey(request))) return unauthorized();

  const d = parsed.data;
  const now = new Date();

  const fields = {
    name: d.name,
    kind: "router",
    firmware: d.firmware ?? null,
    uptimeSec: d.uptimeSec ?? null,
    load1: d.load1 ?? null,
    cpuTempC: d.cpuTempC ?? null,
    memTotalMb: d.memTotalMb ?? null,
    memUsedMb: d.memUsedMb ?? null,
    wanUp: d.wanUp ?? null,
    wanIp: d.wanIp ?? null,
    clientCount: d.clientCount ?? null,
    leaseCount: d.leaseCount ?? null,
    lastSeenAt: now,
  };

  const device = await prisma.networkDevice.upsert({
    where: { host: d.host },
    update: fields,
    create: { host: d.host, ...fields },
  });

  // WAN throughput history point (null rates on the first poll → store 0).
  await prisma.networkDeviceSample.create({
    data: { deviceId: device.id, rxBps: d.wanRxBps ?? 0, txBps: d.wanTxBps ?? 0 },
  });

  // Wifi radios: upsert each reported one, then drop any that vanished.
  const radios = d.radios ?? [];
  for (const r of radios) {
    const fields = {
      band: r.band,
      ssid: r.ssid,
      channel: r.channel ?? null,
      width: r.width ?? null,
      txPowerDbm: r.txPowerDbm ?? null,
      maxRateMbps: r.maxRateMbps ?? null,
      clientCount: r.clientCount,
    };
    await prisma.networkRadio.upsert({
      where: { deviceId_ifname: { deviceId: device.id, ifname: r.ifname } },
      update: fields,
      create: { deviceId: device.id, ifname: r.ifname, ...fields },
    });
  }
  await prisma.networkRadio.deleteMany({
    where: { deviceId: device.id, ifname: { notIn: radios.map((r) => r.ifname) } },
  });

  // Device inventory: upsert each reported client (firstSeen preserved, lastSeen
  // bumped), then mark every other known client offline (kept for history).
  const clients = d.clients ?? [];
  for (const c of clients) {
    const fields = {
      ip: c.ip ?? null,
      hostname: c.hostname ?? null,
      online: c.online,
      band: c.band ?? null,
      radioIf: c.radioIf ?? null,
      signalDbm: c.signalDbm ?? null,
      rxRateMbps: c.rxRateMbps ?? null,
      txRateMbps: c.txRateMbps ?? null,
      lastSeen: now,
    };
    const row = await prisma.networkClient.upsert({
      where: { deviceId_mac: { deviceId: device.id, mac: c.mac } },
      update: fields,
      create: { deviceId: device.id, mac: c.mac, firstSeen: now, ...fields },
    });
    // Wifi clients: record a signal/rate history point for the trend sparkline.
    if (c.band && (c.signalDbm != null || c.rxRateMbps != null)) {
      await prisma.networkClientSample.create({
        data: {
          clientId: row.id,
          signalDbm: c.signalDbm ?? null,
          rxRateMbps: c.rxRateMbps ?? null,
          txRateMbps: c.txRateMbps ?? null,
          at: now,
        },
      });
    }
  }
  if (clients.length) {
    await prisma.networkClient.updateMany({
      where: { deviceId: device.id, mac: { notIn: clients.map((c) => c.mac) }, online: true },
      data: { online: false },
    });
  }

  await reconcileAlert(
    "router-temp-high",
    d.host,
    d.cpuTempC != null && d.cpuTempC >= TEMP_WARN_C,
    `Router ${d.name} (${d.host}) CPU ${d.cpuTempC}°C ≥ ${TEMP_WARN_C}°C`,
    d.name,
  );
  await reconcileAlert(
    "router-wan-down",
    d.host,
    d.wanUp === false,
    `Router ${d.name} (${d.host}) WAN is DOWN`,
    d.name,
  );

  return NextResponse.json({ ok: true });
}

// Open a service-scoped alert (serverId null) when `bad`, resolve it when not —
// the same open/update/resolve dance the SNMP port-error path uses, keyed on
// the alert type + the router host so each router has its own alert.
async function reconcileAlert(
  type: string,
  host: string,
  bad: boolean,
  message: string,
  serverName: string,
) {
  const open = await prisma.alert.findFirst({
    where: { resolved: false, type, message: { contains: host } },
  });
  if (bad) {
    if (!open) {
      const created = await prisma.alert.create({
        data: { serverId: null, type, severity: "warning", message },
      });
      void notifyAlert({
        type: created.type,
        severity: created.severity,
        message: created.message,
        serverName,
        createdAt: created.createdAt,
      });
    } else if (open.message !== message) {
      await prisma.alert.update({ where: { id: open.id }, data: { message } });
    }
  } else if (open) {
    await prisma.alert.update({
      where: { id: open.id },
      data: { resolved: true, resolvedAt: new Date() },
    });
  }
}
