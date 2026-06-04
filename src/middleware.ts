import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-constants";

// Paths the middleware leaves alone. Auth pages, the agent ingest API, and
// the internal sweep route all use their own auth (or are deliberately open
// behind the VPN). Static assets are filtered by the matcher below.
const PUBLIC_PREFIXES = [
  "/login",
  "/register",
  "/invite",
  "/api/auth",
  "/api/agent",
  "/api/internal",
  // Token-gated public status page (the page itself checks STATUS_PAGE_TOKEN).
  "/status",
];

/**
 * Cookie-presence gate. We DO NOT hit the DB here — the Edge runtime can't
 * import Prisma. Pages and API routes that need the actual user still call
 * `getCurrentUser()` and treat null as 401. This middleware just avoids
 * rendering signed-in chrome to anonymous users.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasCookie) return NextResponse.next();

  // API requests get a JSON 401; page requests get a redirect to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals and common static files.
  matcher: [
    "/((?!_next/|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
