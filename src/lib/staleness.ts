// Server-staleness rules.
//
// - "stale": no metric for >2 min. UI may render the cached status muted.
// - "offline": no check-in for >5 min. The sweep route flips the DB status
//   to "offline" and opens an "agent-missing" alert.
//
// Numbers are conservative; if the agent reports every 30s these only fire
// after multiple consecutive failures.
export const STALE_AFTER_MS = 2 * 60 * 1000;
export const OFFLINE_AFTER_MS = 5 * 60 * 1000;

export function isStale(lastSeenAt: Date | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return true;
  return now - new Date(lastSeenAt).getTime() > STALE_AFTER_MS;
}

export function isOffline(lastSeenAt: Date | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return true;
  return now - new Date(lastSeenAt).getTime() > OFFLINE_AFTER_MS;
}
