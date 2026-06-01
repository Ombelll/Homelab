import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma";

/**
 * Verify that an incoming agent request carries a valid API key.
 *
 * Two paths:
 *   1. The AGENT_API_KEY env var — global shared secret (no host binding).
 *   2. A hashed value stored in the AgentKey table. Each row may optionally
 *      be bound to a specific hostname; if so, the request's hostname (read
 *      out of the request body) must match for the key to be accepted.
 *
 * Uses timing-safe comparison on the env-var path. AgentKey lookup is via
 * SHA-256 hash so the plaintext key never lives in the DB.
 */
export async function verifyAgentKey(
  request: Request,
  options?: { hostname?: string },
): Promise<boolean> {
  const provided = request.headers.get("x-agent-key");
  if (!provided) return false;

  const envKey = process.env.AGENT_API_KEY;
  if (envKey && envKey.length > 0) {
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(envKey);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return true;
      }
    } catch {
      // fall through to DB lookup
    }
  }

  const hash = createHash("sha256").update(provided).digest("hex");
  const record = await prisma.agentKey.findUnique({ where: { keyHash: hash } });
  if (!record || record.revokedAt) return false;

  // If this key is hostname-scoped, the request must match. Compare
  // case-insensitively so an agent reporting "ALPHA.lan" still works when
  // the key was registered as "alpha.lan".
  if (record.hostname) {
    if (!options?.hostname) return false;
    if (record.hostname.toLowerCase() !== options.hostname.toLowerCase()) {
      return false;
    }
  }

  await prisma.agentKey.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });
  return true;
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
