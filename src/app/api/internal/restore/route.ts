import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/authz";
import { importBackup, type BackupBundle } from "@/lib/backup";
import { SESSION_COOKIE } from "@/lib/session-constants";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: BackupBundle;
  try {
    body = (await request.json()) as BackupBundle;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Look up the current session row by hash so the importer stays signed in.
  const token = cookies().get(SESSION_COOKIE)?.value;
  let keepSessionId: string | undefined;
  if (token) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = await prisma.session.findUnique({ where: { tokenHash } });
    keepSessionId = session?.id;
  }

  try {
    await importBackup(body, { keepSessionId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: `restore failed: ${(err as Error).message}` },
      { status: 400 },
    );
  }
}
