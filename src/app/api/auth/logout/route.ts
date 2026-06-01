import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, destroySessionByToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    await destroySessionByToken(token);
  }
  cookies().delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
