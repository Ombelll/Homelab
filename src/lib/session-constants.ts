// Constants safe to import from the Edge runtime (middleware). Anything in
// this file must NOT pull in node:crypto, Prisma, or next/headers.
export const SESSION_COOKIE = "homelab_session";
