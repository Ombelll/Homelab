import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * NUT-backed UPS reading. Runs `upsc <name>` (the NUT client) and parses the
 * key variables. Returns undefined when NUT isn't installed or no UPS is
 * configured — so only the host wired to the UPS ever reports this, and every
 * other agent stays silent.
 *
 * The UPS name is auto-discovered via `upsc -l` (lists configured UPSes);
 * override with AGENT_UPS_NAME if you run more than one.
 */
export type UpsInfo = {
  name: string;
  status: string; // raw ups.status: "OL", "OB", "LB", "OL CHRG", ...
  batteryPercent?: number;
  loadPercent?: number;
  runtimeSec?: number;
  inputVoltage?: number;
};

function ups(args: string[]) {
  return execFileAsync("upsc", args, { timeout: 5000 });
}

export async function getUps(): Promise<UpsInfo | undefined> {
  if (process.platform !== "linux") return undefined;

  try {
    let name = process.env.AGENT_UPS_NAME?.trim();
    if (!name) {
      const { stdout } = await ups(["-l"]);
      name = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)[0];
    }
    if (!name) return undefined;

    const { stdout } = await ups([name]);
    const map = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }

    const status = map.get("ups.status");
    if (!status) return undefined;

    const num = (k: string): number | undefined => {
      const v = map.get(k);
      if (v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    return {
      name,
      status,
      batteryPercent: num("battery.charge"),
      loadPercent: num("ups.load"),
      runtimeSec: num("battery.runtime"),
      inputVoltage: num("input.voltage"),
    };
  } catch {
    // upsc missing / NUT not running / no UPS — not an error, just no data.
    return undefined;
  }
}
