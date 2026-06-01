import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, clientIp, _resetRateLimitForTests } from "@/lib/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => _resetRateLimitForTests());

  it("allows up to `limit` requests in the window", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("k", 5, 60_000).ok).toBe(true);
    }
    expect(rateLimit("k", 5, 60_000).ok).toBe(false);
  });

  it("decrements `remaining` per allowed call", () => {
    expect(rateLimit("k", 3, 60_000).remaining).toBe(2);
    expect(rateLimit("k", 3, 60_000).remaining).toBe(1);
    expect(rateLimit("k", 3, 60_000).remaining).toBe(0);
  });

  it("scopes buckets independently per key", () => {
    for (let i = 0; i < 5; i++) rateLimit("a", 5, 60_000);
    expect(rateLimit("a", 5, 60_000).ok).toBe(false);
    expect(rateLimit("b", 5, 60_000).ok).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers the first entry of x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" });
    expect(clientIp(h)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    const h = new Headers({ "x-real-ip": "5.6.7.8" });
    expect(clientIp(h)).toBe("5.6.7.8");
  });

  it("returns 'unknown' when no header is set", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
