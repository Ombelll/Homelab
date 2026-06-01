import { NextResponse } from "next/server";
import { getCurrentUser, type CurrentUser } from "@/lib/session";

/**
 * Authorisation helpers for API routes.
 *
 * Patterns:
 *   const guard = await requireUser();
 *   if (!guard.ok) return guard.response;
 *   const user = guard.user;
 *
 *   const guard = await requireAdmin();
 *   if (!guard.ok) return guard.response;
 */

export type Guard =
  | { ok: true; user: CurrentUser }
  | { ok: false; response: Response };

export async function requireUser(): Promise<Guard> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, user };
}

export async function requireAdmin(): Promise<Guard> {
  const guard = await requireUser();
  if (!guard.ok) return guard;
  if (guard.user.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "admin role required" },
        { status: 403 },
      ),
    };
  }
  return guard;
}
