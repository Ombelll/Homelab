import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export type SpeedtestResult = {
  downloadMbps: number;
  uploadMbps: number;
  pingMs: number;
  server?: string;
  testedAt: string; // ISO
};

// Read the latest completed result straight out of speedtest-tracker's sqlite
// via the bundled PHP (no sqlite3 CLI in the image; no API token needed).
// download/upload are stored in BYTES/sec → ×8/1e6 = Mbps. Fixed literal,
// passed as one argv element (no shell) — safe.
const PHP = [
  '$c=["/config/database.sqlite","/app/www/database/database.sqlite"];',
  '$db=null;foreach($c as $f){if(file_exists($f)){$db=$f;break;}}',
  'if(!$db){fwrite(STDERR,"no db");exit(1);}',
  '$p=new PDO("sqlite:$db");',
  '$q=$p->query("SELECT download,upload,ping,service,created_at FROM results WHERE status=\'completed\' ORDER BY id DESC LIMIT 1");',
  '$r=$q?$q->fetch(PDO::FETCH_ASSOC):null;',
  'if($r)echo json_encode($r);',
].join("");

/**
 * Return the most recent completed speed test, or null when speedtest polling
 * isn't configured (AGENT_SPEEDTEST_CONTAINER unset) or the read fails.
 */
export async function getLatestSpeedtest(): Promise<SpeedtestResult | null> {
  const container = config.speedtestContainer;
  if (!container) return null;

  let stdout: string;
  try {
    const res = await execFileAsync("docker", ["exec", container, "php", "-r", PHP], {
      timeout: 10000,
      maxBuffer: 1 << 20,
    });
    stdout = res.stdout.trim();
  } catch (err) {
    console.error("[agent] speedtest read failed:", (err as Error).message);
    return null;
  }
  if (!stdout) return null;

  let row: { download?: number; upload?: number; ping?: number; service?: string; created_at?: string };
  try {
    row = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (row.download == null || row.upload == null || row.ping == null || !row.created_at) return null;

  // speedtest-tracker stores created_at as "YYYY-MM-DD HH:MM:SS" (UTC). Make it
  // an explicit ISO-UTC string so the dashboard parses it unambiguously.
  const testedAt = `${row.created_at.replace(" ", "T")}Z`;

  return {
    downloadMbps: Math.round((row.download * 8) / 1e6 * 10) / 10,
    uploadMbps: Math.round((row.upload * 8) / 1e6 * 10) / 10,
    pingMs: Math.round(row.ping * 10) / 10,
    server: row.service || undefined,
    testedAt,
  };
}
