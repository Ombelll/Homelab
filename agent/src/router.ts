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

export type RouterClient = {
  mac: string; // lower-case
  ip?: string;
  hostname?: string;
  online: boolean;
  band?: string; // wifi band when associated
  radioIf?: string;
  signalDbm?: number;
  rxRateMbps?: number;
  txRateMbps?: number;
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
  clients?: RouterClient[];
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
  // Device inventory: DHCP leases (mac|ip|hostname) + reachable ARP (mac|ip).
  'awk \'{print "LEASE|" $2 "|" $3 "|" $4}\' /tmp/dhcp.leases 2>/dev/null',
  'awk \'NR>1 && $3=="0x2" {print "ARP|" $4 "|" $1}\' /proc/net/arp 2>/dev/null',
  // Per-radio wifi: discover interfaces from `iwinfo` (driver-agnostic — the
  // MTK driver doesn't populate /sys .../wireless), keep only AP (Master) VIFs,
  // emit one RADIO line + one WIFI line per associated station.
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
    // One WIFI line per station: MAC, signal, RX rate, TX rate (band from freq).
    'iwinfo "$r" assoclist 2>/dev/null | awk -v rf="$r" -v fr="$freq" ' +
      '\'function band(f){return (f+0)>=5?"5 GHz":"2.4 GHz"} ' +
      '/^[0-9A-Fa-f][0-9A-Fa-f]:/{mac=$1;sig=$2} ' +
      '$1=="RX:"{rx=$2} ' +
      '$1=="TX:"{tx=$2;print "WIFI|" mac "|" band(fr) "|" rf "|" sig "|" rx "|" tx}\'; ' +
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

  // Device inventory: merge DHCP leases + reachable ARP + wifi assoc by MAC.
  const byMac = new Map<string, RouterClient>();
  const get = (macRaw: string): RouterClient => {
    const mac = macRaw.trim().toLowerCase();
    let c = byMac.get(mac);
    if (!c) {
      c = { mac, online: false };
      byMac.set(mac, c);
    }
    return c;
  };
  for (const line of stdout.split("\n")) {
    const p = line.split("|");
    if (p[0] === "LEASE" && p.length >= 4) {
      const c = get(p[1]);
      if (p[2]) c.ip = p[2];
      if (p[3] && p[3] !== "*") c.hostname = p[3];
    } else if (p[0] === "ARP" && p.length >= 3) {
      const c = get(p[1]);
      if (p[2]) c.ip = c.ip ?? p[2];
      c.online = true; // in the reachable ARP table right now
    } else if (p[0] === "WIFI" && p.length >= 7) {
      // WIFI|mac|band|radioIf|signal|rxRate|txRate
      const c = get(p[1]);
      c.online = true; // associated == online
      c.band = p[2] || undefined;
      c.radioIf = p[3] || undefined;
      c.signalDbm = num(p[4]);
      c.rxRateMbps = num(p[5]);
      c.txRateMbps = num(p[6]);
    }
  }
  if (byMac.size) stats.clients = Array.from(byMac.values()).slice(0, 128);

  return stats;
}
