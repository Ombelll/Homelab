import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma";

/**
 * Verify that an incoming agent request carries a valid API key.
 *
 * The key may match either:
 *   1. The AGENT_API_KEY env var (simple shared secret, recommended for MVP), or
 *   2. A hashed value stored in the AgentKey table (per-agent keys, rotation).
 *
 * Returns true on success. Uses timing-safe comparison for the env-var path.
 */
export async function verifyAgentKey(request: Request): Promise<boolean> {
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
