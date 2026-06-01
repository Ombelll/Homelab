import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/authz";
import { exportBackup } from "@/lib/backup";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const bundle = await exportBackup();

  const filename = `homelab-backup-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
