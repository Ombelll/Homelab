import { promises as fs } from "node:fs";
import path from "node:path";

export type SensorReading = {
  name: string;
  kind: "temperature" | "fan" | "power";
  value: number;
  unit: string;
};

/**
 * Best-effort hardware sensor readings.
 *
 * Linux: walks /sys/class/hwmon/* and reads temp/fan/power inputs. This works
 * without root for most sensors, and without external tools like `lm-sensors`.
 *
 * macOS / Windows: returns an empty array. The right path on macOS is
 * SMC via a native helper (no clean shell-only option); on Windows it's
 * OpenHardwareMonitor or LibreHardwareMonitor. Out of scope for MVP — if
 * someone needs them, they can extend this file.
 */
export async function getSensors(): Promise<SensorReading[]> {
  if (process.platform !== "linux") return [];
  try {
    return await readLinuxHwmon();
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
