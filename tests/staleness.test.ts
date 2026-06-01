import { describe, it, expect } from "vitest";
import { isStale, isOffline, STALE_AFTER_MS, OFFLINE_AFTER_MS } from "@/lib/staleness";

const NOW = new Date("2026-06-01T12:00:00Z").getTime();

describe("staleness", () => {
  it("treats null lastSeen as stale and offline", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isOffline(null, NOW)).toBe(true);
  });

  it("returns false for a fresh check-in", () => {
    const fresh = new Date(NOW - 10_000);
    expect(isStale(fresh, NOW)).toBe(false);
    expect(isOffline(fresh, NOW)).toBe(false);
  });

  it("flips to stale just past the stale threshold", () => {
    const justOver = new Date(NOW - STALE_AFTER_MS - 1);
    const justUnder = new Date(NOW - STALE_AFTER_MS + 1000);
    expect(isStale(justOver, NOW)).toBe(true);
    expect(isStale(justUnder, NOW)).toBe(false);
  });

  it("flips to offline only at the offline threshold (which is later)", () => {
    const stalebutNotOffline = new Date(NOW - STALE_AFTER_MS - 1000);
    expect(isStale(stalebutNotOffline, NOW)).toBe(true);
    expect(isOffline(stalebutNotOffline, NOW)).toBe(false);

    const offline = new Date(NOW - OFFLINE_AFTER_MS - 1000);
    expect(isOffline(offline, NOW)).toBe(true);
  });
});
