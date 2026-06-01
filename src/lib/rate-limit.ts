/**
 * Per-key rate limiter using a fixed-window counter.
 *
 * Intentionally in-memory: one dashboard process, one bucket. If you ever
 * run multiple replicas this needs a shared store (Redis), but for the
 * MVP single-process deploy this is enough and dependency-free.
 *
 * Used for login throttling. Behind a VPN this is mostly belt-and-braces,
 * but it costs almost nothing and closes the "brute-force if ever exposed"
 * gap I flagged earlier.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

const SWEEP_INTERVAL_MS = 60 * 1000;
let sweepTimer: NodeJS.Timeout | null = null;
function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the Node process alive just for sweeping.
  sweepTimer.unref?.();
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
};

/**
 * Increment the bucket for `key` and return whether the action is allowed.
 *
 *   limit: max requests per window
 *   windowMs: window length
 *
 * Allowed when the bucket has space; rejects with `ok=false` once it's
 * full. Bucket is cleared automatically once its window expires.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  ensureSweeper();
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: true, remaining: limit - 1, resetAt };
  }

  if (existing.count >= limit) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count++;
  return {
    ok: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
  };
}

/** Resolve the client IP via the common reverse-proxy headers. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}

// Test helper — never used in production code paths.
export function _resetRateLimitForTests(): void {
  buckets.clear();
}
