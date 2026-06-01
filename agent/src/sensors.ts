import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SensorReading = {
  name: string;
  kind: "temperature" | "fan" | "power";
  value: number;
  unit: string;
};

/**
 * Best-effort hardware sensor readings.
 *
 * Linux: walks /sys/class/hwmon/* and reads temp/fan/power inputs without
 * needing root or extra tools.
 *
 * Windows: queries the WMI namespace published by OpenHardwareMonitor or
 * LibreHardwareMonitor. The user must have one of those running (typically
 * as a service, elevated). If neither is running we silently return [].
 *
 * macOS: still empty — would need an SMC helper binary.
 */
export async function getSensors(): Promise<SensorReading[]> {
  try {
    if (process.platform === "linux") return await readLinuxHwmon();
    if (process.platform === "win32") return await readWindowsWMI();
    return [];
  } catch (err) {
    console.warn("[agent] sensor read failed:", (err as Error).message);
    return [];
  }
}

async function readLinuxHwmon(): Promise<SensorReading[]> {
  const root = "/sys/class/hwmon";
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const out: SensorReading[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    let chip: string;
    try {
      chip = (await fs.readFile(path.join(dir, "name"), "utf8")).trim();
    } catch {
      chip = entry;
    }

    // We don't know which numbered inputs exist; just scan a small range.
    for (let i = 1; i <= 16; i++) {
      // Temperature
      await tryRead(out, dir, chip, `temp${i}`, "temperature", 0.001, "°C");
      // Fan RPM (no scale)
      await tryRead(out, dir, chip, `fan${i}`, "fan", 1, "RPM");
      // Power in microwatts → watts
      await tryRead(out, dir, chip, `power${i}`, "power", 1e-6, "W");
    }
  }
  // Cap at a sane number so a chatty box doesn't flood the API.
  return out.slice(0, 64);
}

/**
 * Read sensors via WMI from OpenHardwareMonitor (OHM) or LibreHardwareMonitor
 * (LHM). Both publish a "Sensor" class under their own root namespace. We
 * try LHM first (more actively maintained), fall back to OHM.
 *
 * Requires the user to run OHM/LHM as a service, typically as Administrator
 * to access motherboard / CPU sensors. If neither is running, the WMI query
 * returns an empty result set and we propagate that as [].
 */
async function readWindowsWMI(): Promise<SensorReading[]> {
  for (const ns of ["root/LibreHardwareMonitor", "root/OpenHardwareMonitor"]) {
    const rows = await queryWMI(ns).catch(() => null);
    if (rows && rows.length > 0) return rows.slice(0, 64);
  }
  return [];
}

async function queryWMI(namespace: string): Promise<SensorReading[]> {
  // The Sensor class exposes Name, Value, SensorType, Parent (the
  // identifier of the chip). SensorType values include "Temperature",
  // "Fan", "Power", and many others — we only emit the three we model.
  //
  // -ErrorAction Stop turns "namespace doesn't exist" into a terminating
  // error we can catch, instead of silent empty output.
  const script = `
    $ErrorActionPreference = 'Stop'
    Get-CimInstance -Namespace "${namespace}" -ClassName Sensor |
      Where-Object { $_.SensorType -in @('Temperature','Fan','Power') } |
      Select-Object Name, Value, SensorType, Parent |
      ConvertTo-Json -Compress -Depth 2
  `.trim();

  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Single-object case (one sensor) emits a bare object; array otherwise.
  const parsed: unknown = JSON.parse(trimmed.startsWith("[") ? trimmed : `[${trimmed}]`);
  if (!Array.isArray(parsed)) return [];

  const out: SensorReading[] = [];
  for (const row of parsed as Array<Record<string, unknown>>) {
    const rawType = String(row.SensorType ?? "").toLowerCase();
    const kind =
      rawType === "temperature" ? "temperature" :
      rawType === "fan" ? "fan" :
      rawType === "power" ? "power" : null;
    if (!kind) continue;

    const name = String(row.Name ?? "").trim();
    const parent = String(row.Parent ?? "").trim();
    const value = Number(row.Value);
    if (!name || !Number.isFinite(value)) continue;

    const unit = kind === "temperature" ? "°C" : kind === "fan" ? "RPM" : "W";
    // Prefix with the parent identifier so multiple sensors with the same
    // human name (e.g. "Core #1" on each CPU) stay distinct.
    out.push({
      name: parent ? `${parent}:${name}` : name,
      kind,
      value: Math.round(value * 100) / 100,
      unit,
    });
  }
  return out;
}

async function tryRead(
  out: SensorReading[],
  dir: string,
  chip: string,
  base: string,
  kind: SensorReading["kind"],
  scale: number,
  unit: string,
) {
  const inputPath = path.join(dir, `${base}_input`);
  let raw: string;
  try {
    raw = await fs.readFile(inputPath, "utf8");
  } catch {
    return; // input doesn't exist
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return;

  // Optional label file for human-readable name (e.g. "Core 0", "CPU Tdie").
  let label = "";
  try {
    label = (await fs.readFile(path.join(dir, `${base}_label`), "utf8")).trim();
  } catch {
    /* no label */
  }
  const name = label ? `${chip}:${label}` : `${chip}:${base}`;

  out.push({
    name,
    kind,
    value: Math.round(n * scale * 100) / 100,
    unit,
  });
}
