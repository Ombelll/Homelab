import snmp from "net-snmp";
import { config } from "./config.js";

export type SnmpPort = {
  ifIndex: number;
  name: string;
  status: string; // ifOperStatus text: up/down/...
  adminUp?: boolean; // ifAdminStatus == up (distinguishes disabled from broken)
  speedMbps?: number; // ifHighSpeed (Mbit/s); 0 when the link is down
  rxBps?: number;
  txBps?: number;
  inErrors?: number; // cumulative ifInErrors
  outErrors?: number; // cumulative ifOutErrors
  inDiscards?: number; // cumulative ifInDiscards
  outDiscards?: number; // cumulative ifOutDiscards
};

export type SnmpDevice = {
  host: string;
  name: string;
  vendor?: string;
  uptimeSec?: number;
  ports: SnmpPort[];
};

// Standard MIB-2 / IF-MIB OIDs. ifName + 64-bit HC octet counters live in the
// ifXTable; oper-status, descr and error counters in the classic ifTable.
const OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0", // TimeTicks, 1/100 s
  ifDescr: "1.3.6.1.2.1.2.2.1.2",
  ifAdminStatus: "1.3.6.1.2.1.2.2.1.7",
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  ifInDiscards: "1.3.6.1.2.1.2.2.1.13",
  ifInErrors: "1.3.6.1.2.1.2.2.1.14",
  ifOutDiscards: "1.3.6.1.2.1.2.2.1.19",
  ifOutErrors: "1.3.6.1.2.1.2.2.1.20",
  ifName: "1.3.6.1.2.1.31.1.1.1.1",
  ifHCInOctets: "1.3.6.1.2.1.31.1.1.1.6",
  ifHCOutOctets: "1.3.6.1.2.1.31.1.1.1.10",
  ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15", // Mbit/s
} as const;

const OPER_STATUS: Record<number, string> = {
  1: "up",
  2: "down",
  3: "testing",
  4: "unknown",
  5: "dormant",
  6: "notPresent",
  7: "lowerLayerDown",
};

type Snap = { in: number; out: number; at: number };
// Per-interface octet snapshot from the previous poll, for delta -> bps.
const prevSnapshot = new Map<number, Snap>();

/**
 * Poll the configured SNMP target (a managed switch) and return its interfaces
 * with per-port throughput (from the octet-counter delta, like network.ts).
 * Returns null when SNMP isn't configured or the poll fails. First poll yields
 * no rates (needs two samples). Tuned against standard IF-MIB; verify OIDs
 * against the real device.
 */
export async function getSnmpDevice(): Promise<SnmpDevice | null> {
  const target = config.snmpTarget;
  if (!target) return null;

  const session = snmp.createSession(target, config.snmpCommunity, {
    version: snmp.Version2c,
    timeout: 5000,
    retries: 1,
  });

  try {
    const [scalars, ifName, ifDescr, admin, oper, speed, hcIn, hcOut, inErr, outErr, inDisc, outDisc] =
      await Promise.all([
        getScalars(session),
        walk(session, OID.ifName),
        walk(session, OID.ifDescr),
        walk(session, OID.ifAdminStatus),
        walk(session, OID.ifOperStatus),
        walk(session, OID.ifHighSpeed),
        walk(session, OID.ifHCInOctets),
        walk(session, OID.ifHCOutOctets),
        walk(session, OID.ifInErrors),
        walk(session, OID.ifOutErrors),
        walk(session, OID.ifInDiscards),
        walk(session, OID.ifOutDiscards),
      ]);

    const now = Date.now();
    const ports: SnmpPort[] = [];
    for (const [idx, statusRaw] of oper) {
      const name = toStr(ifName.get(idx)) || toStr(ifDescr.get(idx)) || `if${idx}`;
      const statusNum = toNum(statusRaw);
      const status = (statusNum != null && OPER_STATUS[statusNum]) || String(statusRaw);
      const port: SnmpPort = { ifIndex: idx, name, status };

      const adminNum = toNum(admin.get(idx));
      if (adminNum != null) port.adminUp = adminNum === 1;
      const sp = toNum(speed.get(idx));
      if (sp != null) port.speedMbps = sp;

      const inOct = toNum(hcIn.get(idx));
      const outOct = toNum(hcOut.get(idx));
      if (inOct != null && outOct != null) {
        const prev = prevSnapshot.get(idx);
        prevSnapshot.set(idx, { in: inOct, out: outOct, at: now });
        if (prev) {
          const sec = (now - prev.at) / 1000;
          const din = inOct - prev.in;
          const dout = outOct - prev.out;
          if (sec > 0 && din >= 0) port.rxBps = Math.round(din / sec);
          if (sec > 0 && dout >= 0) port.txBps = Math.round(dout / sec);
        }
      }

      const ie = toNum(inErr.get(idx));
      if (ie != null) port.inErrors = ie;
      const oe = toNum(outErr.get(idx));
      if (oe != null) port.outErrors = oe;
      const id_ = toNum(inDisc.get(idx));
      if (id_ != null) port.inDiscards = id_;
      const od = toNum(outDisc.get(idx));
      if (od != null) port.outDiscards = od;

      ports.push(port);
    }

    return {
      host: target,
      name: toStr(scalars.sysName) || target,
      vendor: toStr(scalars.sysDescr)?.slice(0, 120) || undefined,
      uptimeSec: scalars.sysUpTime != null ? Math.floor(Number(scalars.sysUpTime) / 100) : undefined,
      ports,
    };
  } catch (err) {
    console.error("[agent] snmp poll failed:", (err as Error).message);
    return null;
  } finally {
    try {
      session.close();
    } catch {
      /* already closed */
    }
  }
}

// Walk a single column OID and return Map<ifIndex, value>. ifIndex is the last
// sub-identifier of each returned OID.
function walk(session: any, oid: string): Promise<Map<number, unknown>> {
  return new Promise((resolve, reject) => {
    const out = new Map<number, unknown>();
    session.subtree(
      oid,
      20,
      (varbinds: any[]) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          const parts = String(vb.oid).split(".");
          const idx = Number(parts[parts.length - 1]);
          if (Number.isFinite(idx)) out.set(idx, vb.value);
        }
      },
      (error: Error | null) => (error ? reject(error) : resolve(out)),
    );
  });
}

function getScalars(
  session: any,
): Promise<{ sysName?: unknown; sysDescr?: unknown; sysUpTime?: unknown }> {
  return new Promise((resolve, reject) => {
    session.get(
      [OID.sysName, OID.sysDescr, OID.sysUpTime],
      (error: Error | null, varbinds: any[]) => {
        if (error) return reject(error);
        resolve({
          sysName: varbinds?.[0]?.value,
          sysDescr: varbinds?.[1]?.value,
          sysUpTime: varbinds?.[2]?.value,
        });
      },
    );
  });
}

function toStr(v: unknown): string {
  if (v == null) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8").trim();
  return String(v).trim();
}

// SNMP numbers arrive as JS numbers (Integer/Counter32/TimeTicks) or as a
// big-endian Buffer for Counter64 (the HC octet counters). Read either.
function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Buffer.isBuffer(v)) {
    let n = 0n;
    for (const b of v) n = (n << 8n) | BigInt(b);
    return Number(n);
  }
  const n = Number(v as never);
  return Number.isFinite(n) ? n : null;
}
