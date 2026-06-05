import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SmartDevice = {
  device: string;
  model?: string;
  serial?: string;
  healthy: boolean;
  tempC?: number;
  powerOnHours?: number;
  reallocatedSectors?: number;
  wearPercent?: number;
  mediaErrors?: number;
  criticalWarning?: number;
  availableSparePercent?: number;
  selfTestStatus?: string;
};

type ScanJson = { devices?: Array<{ name?: string }> };

type SmartJson = {
  device?: { name?: string };
  model_name?: string;
  serial_number?: string;
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  nvme_smart_health_information_log?: {
    percentage_used?: number;
    media_errors?: number;
    critical_warning?: number;
    available_spare?: number;
  };
  ata_smart_attributes?: { table?: Array<{ id?: number; raw?: { value?: number } }> };
  // Self-test log (ATA + NVMe shapes differ). Newest entry is first.
  ata_smart_self_test_log?: {
    standard?: { table?: Array<{ status?: { string?: string; passed?: boolean }; lifetime_hours?: number }> };
  };
  nvme_self_test_log?: {
    current_self_test_operation?: { value?: number };
    table?: Array<{ self_test_result?: { string?: string }; power_on_hours?: number }>;
  };
};

// Trigger a fresh long self-test when the newest one is older than this many
// power-on hours (≈ weekly), so a degrading surface is caught proactively.
const SELFTEST_INTERVAL_HOURS = 168;

// SMART data changes slowly and `smartctl` is comparatively heavy, so we
// refresh at most every REFRESH_MS and serve the cached result on the ticks
// in between (the report still carries the devices every tick, so the
// dashboard's upsert/delete-diff stays stable).
const REFRESH_MS = 5 * 60 * 1000;
let cache: { at: number; devices: SmartDevice[] } | null = null;

/**
 * Per-disk SMART health via `smartctl` (smartmontools). Linux only; returns []
 * when smartmontools isn't installed, we lack permission, or there are no real
 * disks (e.g. inside an unprivileged container). Best-effort throughout: a
 * drive that doesn't expose a given attribute simply omits that field.
 */
export async function getSmartDevices(): Promise<SmartDevice[]> {
  if (process.platform !== "linux") return [];

  const now = Date.now();
  if (cache && now - cache.at < REFRESH_MS) return cache.devices;

  const scanOut = await smartctl(["--scan", "-j"]);
  if (!scanOut) {
    cache = { at: now, devices: [] };
    return [];
  }

  let names: string[];
  try {
    const scan = JSON.parse(scanOut) as ScanJson;
    names = (scan.devices ?? []).map((d) => d.name).filter((n): n is string => Boolean(n));
  } catch {
    cache = { at: now, devices: [] };
    return [];
  }

  const out: SmartDevice[] = [];
  for (const name of names) {
    const dev = await readDevice(name);
    if (dev) out.push(dev);
  }
  cache = { at: now, devices: out };
  return out;
}

async function readDevice(name: string): Promise<SmartDevice | null> {
  const stdout = await smartctl(["-H", "-A", "-i", "-l", "selftest", "-j", name]);
  if (!stdout) return null;

  let j: SmartJson;
  try {
    j = JSON.parse(stdout) as SmartJson;
  } catch {
    return null;
  }

  // No smart_status means smartctl couldn't read SMART (USB bridge, virtual
  // device) — skip rather than report a misleading "healthy".
  const passed = j.smart_status?.passed;
  if (passed === undefined) return null;

  const dev: SmartDevice = { device: j.device?.name ?? name, healthy: passed === true };
  if (typeof j.model_name === "string") dev.model = j.model_name;
  if (typeof j.serial_number === "string") dev.serial = j.serial_number;
  if (typeof j.temperature?.current === "number") dev.tempC = j.temperature.current;
  if (typeof j.power_on_time?.hours === "number") dev.powerOnHours = j.power_on_time.hours;
  const nvme = j.nvme_smart_health_information_log;
  if (typeof nvme?.percentage_used === "number") dev.wearPercent = nvme.percentage_used;
  if (typeof nvme?.media_errors === "number") dev.mediaErrors = nvme.media_errors;
  if (typeof nvme?.critical_warning === "number") dev.criticalWarning = nvme.critical_warning;
  if (typeof nvme?.available_spare === "number") dev.availableSparePercent = nvme.available_spare;
  // ATA "Reallocated_Sector_Ct" is attribute id 5 — a rising raw value is the
  // classic early-failure signal.
  const realloc = j.ata_smart_attributes?.table?.find((a) => a.id === 5);
  if (typeof realloc?.raw?.value === "number") dev.reallocatedSectors = realloc.raw.value;

  // Self-test status + proactive weekly long test.
  const st = readSelfTest(j);
  if (st.status) dev.selfTestStatus = st.status;
  const poh = dev.powerOnHours;
  const dueForTest =
    !st.inProgress &&
    poh != null &&
    (st.lastHours == null || poh - st.lastHours >= SELFTEST_INTERVAL_HOURS);
  if (dueForTest) {
    // Fire-and-forget: `-t long` only SCHEDULES the test and returns at once;
    // the drive runs it in the background and we read the result on later ticks.
    void smartctl(["-t", "long", name]);
  }

  return dev;
}

function readSelfTest(j: SmartJson): { status?: string; inProgress: boolean; lastHours?: number } {
  // NVMe
  if (j.nvme_self_test_log) {
    const inProgress = (j.nvme_self_test_log.current_self_test_operation?.value ?? 0) !== 0;
    const newest = j.nvme_self_test_log.table?.[0];
    return {
      status: inProgress ? "in progress" : newest?.self_test_result?.string,
      inProgress,
      lastHours: newest?.power_on_hours,
    };
  }
  // ATA/SATA
  const table = j.ata_smart_self_test_log?.standard?.table;
  const newest = table?.[0];
  const inProgress = /in progress|remaining/i.test(newest?.status?.string ?? "");
  return { status: newest?.status?.string, inProgress, lastHours: newest?.lifetime_hours };
}

/**
 * Run smartctl and return stdout regardless of exit code. smartctl encodes
 * status as exit-code BITFLAGS (e.g. bit 6 = a self-test logged an error),
 * so a non-zero exit is common on perfectly healthy drives and the JSON on
 * stdout is still valid. Only a missing binary or timeout yields no stdout.
 */
async function smartctl(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("smartctl", args, {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string };
    return typeof e.stdout === "string" && e.stdout.length > 0 ? e.stdout : null;
  }
}
