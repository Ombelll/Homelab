import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export type RouterRadio = {
  ifname: string; // ra0 / rax0 / ra1
  band: string; // "2.4 GHz" | "5 GHz"
  ssid: string;
  channel?: number;
  width?: string; // HT mode, e.g. HE160
  txPowerDbm?: number;
  maxRateMbps?: number;
  clientCount: number;
};

export type RouterStats = {
  host: string; // IP/hostname (user@ stripped) — the device key
  name: string; // model string, e.g. "GL.iNet GL-MT3000"
  firmware?: string;
  uptimeSec?: number;
  load1?: number;
  cpuTempC?: number;
  memTotalMb?: number;
  memUsedMb?: number;
  wanUp?: boolean;
  wanIp?: string;
  wanRxBps?: number;
  wanTxBps?: number;
  clientCount?: number;
  leaseCount?: number;
  radios?: RouterRadio[];
};

// One-shot readout run on the router. Pure /proc + sysfs + uci/ip — no JSON
// parsing on the (ash) router side, just key=value lines we split here. The
// whole string is a fixed literal (no untrusted interpolation), and it's passed
// as a single argv element to execFile("ssh", ...) so no LOCAL shell is invoked.
const REMOTE = [
  'WANDEV=$(uci -q get network.wan.device 2>/dev/null || uci -q get network.wan.ifname 2>/dev/null || echo eth0)',
  'echo "model=$(cat /tmp/sysinfo/model 2>/dev/null)"',
  'echo "firmware=$(cat /etc/glversion 2>/dev/null || sed -n "s/^VERSION=//p" /etc/os-release 2>/dev/null | tr -d \\")"',
  'echo "uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
  'echo "load1=$(cut -d\\  -f1 /proc/loadavg 2>/dev/null)"',
  'echo "mem_total_kb=$(awk \'/^MemTotal:/{print $2}\' /proc/meminfo 2>/dev/null)"',
  'echo "mem_avail_kb=$(awk \'/^MemAvailable:/{print $2}\' /proc/meminfo 2>/dev/null)"',
  'echo "temp_milli=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"',
  'echo "wandev=$WANDEV"',
  'echo "wan_oper=$(cat /sys/class/net/$WANDEV/operstate 2>/dev/null)"',
  'echo "wan_ip=$(ip -4 -o addr show dev $WANDEV 2>/dev/null | awk \'{print $4}\' | head -1)"',
  'echo "wan_rx=$(cat /sys/class/net/$WANDEV/statistics/rx_bytes 2>/dev/null)"',
  'echo "wan_tx=$(cat /sys/class/net/$WANDEV/statistics/tx_bytes 2>/dev/null)"',
  'echo "clients=$(awk \'NR>1 && $3=="0x2"\' /proc/net/arp 2>/dev/null | wc -l)"',
  'echo "leases=$(wc -l < /tmp/dhcp.leases 2>/dev/null)"',
  // Per-radio wifi: discover interfaces from `iwinfo` (driver-agnostic — the
  // MTK driver doesn't populate /sys .../wireless), keep only AP (Master) VIFs,
  // emit one pipe-delimited RADIO line each. Band is derived from frequency.
  'for r in $(iwinfo 2>/dev/null | sed -n "s/^\\([a-zA-Z0-9._-]*\\)[[:space:]]*ESSID:.*/\\1/p"); do ' +
    'info=$(iwinfo "$r" info 2>/dev/null); echo "$info" | grep -q "Mode: Master" || continue; ' +
    'ssid=$(echo "$info" | sed -n \'s/.*ESSID: "\\(.*\\)".*/\\1/p\'); ' +
    'ch=$(echo "$info" | sed -n \'s/.*Channel: \\([0-9]*\\).*/\\1/p\'); ' +
    'freq=$(echo "$info" | sed -n \'s/.*(\\([0-9.]*\\) GHz).*/\\1/p\'); ' +
    'width=$(echo "$info" | sed -n \'s/.*HT Mode: *\\([^ ]*\\).*/\\1/p\'); ' +
    'txp=$(echo "$info" | sed -n \'s/.*Tx-Power: \\([0-9]*\\).*/\\1/p\'); ' +
    'rate=$(echo "$info" | sed -n \'s/.*Bit Rate: \\([0-9.]*\\).*/\\1/p\'); ' +
    'clients=$(iwinfo "$r" assoclist 2>/dev/null | grep -cE "^[0-9A-Fa-f]{2}:"); ' +
    'echo "RADIO|$r|$ssid|$ch|$freq|$width|$txp|$rate|$clients"; ' +
  'done',
].join("; ");

// Previous WAN octet counters, to turn the byte totals into a bytes/sec rate
// (same delta technique as snmp.ts / network.ts). First poll yields no rate.
let prevWan: { rx: number; tx: number; at: number } | null = null;

const num = (s: string | undefined): number | undefined => {
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * SSH into the configured router and read its health stats. Returns null when
 * AGENT_ROUTER_SSH is unset or the poll fails (the tick then just omits it).
 * Key-only auth via the host's SSH key; we never pass a password.
 */
export async function getRouterStats(): Promise<RouterStats | null> {
  const target = config.routerSshTarget;
  if (!target) return null;

  let stdout: string;
  try {
    const res = await execFileAsync(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=6",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=3",
        target,
        REMOTE,
      ],
      { timeout: 12000, maxBuffer: 1 << 20 },
    );
    stdout = res.stdout;
  } catch (err) {
    console.error("[agent] router ssh poll failed:", (err as Error).message);
    return null;
  }

  const kv = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }

  // host = the target minus any user@ prefix (the device's stable key).
  const host = target.includes("@") ? target.slice(target.indexOf("@") + 1) : target;

  const stats: RouterStats = {
    host,
    name: kv.get("model") || host,
  };

  const fw = kv.get("firmware");
  if (fw) stats.firmware = fw.slice(0, 120);
  stats.uptimeSec = num(kv.get("uptime"));
  stats.load1 = num(kv.get("load1"));

  const tempMilli = num(kv.get("temp_milli"));
  if (tempMilli != null) stats.cpuTempC = Math.round((tempMilli / 1000) * 10) / 10;

  const totalKb = num(kv.get("mem_total_kb"));
  const availKb = num(kv.get("mem_avail_kb"));
  if (totalKb != null) {
    stats.memTotalMb = Math.round(totalKb / 1024);
    if (availKb != null) stats.memUsedMb = Math.round((totalKb - availKb) / 1024);
  }

  const oper = kv.get("wan_oper");
  if (oper) stats.wanUp = oper === "up";
  const wanIp = kv.get("wan_ip");
  if (wanIp) stats.wanIp = wanIp;

  const rx = num(kv.get("wan_rx"));
  const tx = num(kv.get("wan_tx"));
  if (rx != null && tx != null) {
    const now = Date.now();
    const prev = prevWan;
    prevWan = { rx, tx, at: now };
    if (prev) {
      const sec = (now - prev.at) / 1000;
      const drx = rx - prev.rx;
      const dtx = tx - prev.tx;
      if (sec > 0 && drx >= 0) stats.wanRxBps = Math.round(drx / sec);
      if (sec > 0 && dtx >= 0) stats.wanTxBps = Math.round(dtx / sec);
    }
  }

  stats.clientCount = num(kv.get("clients"));
  stats.leaseCount = num(kv.get("leases"));

  // Per-radio wifi lines: RADIO|ifname|ssid|channel|freqGHz|width|txp|rate|clients
  const radios: RouterRadio[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("RADIO|")) continue;
    const p = line.split("|");
    if (p.length < 9) continue;
    const [, ifname, ssid, ch, freq, width, txp, rate, clients] = p;
    const freqGHz = num(freq);
    radios.push({
      ifname,
      band: freqGHz != null && freqGHz >= 5 ? "5 GHz" : "2.4 GHz",
      ssid: ssid || ifname,
      channel: num(ch),
      width: width || undefined,
      txPowerDbm: num(txp),
      maxRateMbps: num(rate),
      clientCount: num(clients) ?? 0,
    });
  }
  if (radios.length) stats.radios = radios;

  return stats;
}
