import { describe, it, expect } from "vitest";
import { formatPercent, formatRelativeTime, cn } from "@/lib/utils";

describe("formatPercent", () => {
  it("renders em-dash for null/undefined/NaN", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });

  it("rounds with configurable digits", () => {
    expect(formatPercent(42.567, 0)).toBe("43%");
    expect(formatPercent(42.567, 1)).toBe("42.6%");
  });

  it("accepts 0 as a real value", () => {
    expect(formatPercent(0)).toBe("0%");
  });
});

describe("formatRelativeTime", () => {
  const NOW = Date.now();

  it("returns 'never' for nullish input", () => {
    expect(formatRelativeTime(null)).toBe("never");
    expect(formatRelativeTime(undefined)).toBe("never");
  });

  it("renders seconds / minutes / hours / days bands", () => {
    expect(formatRelativeTime(new Date(NOW - 30_000))).toMatch(/s ago$/);
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000))).toMatch(/m ago$/);
    expect(formatRelativeTime(new Date(NOW - 3 * 60 * 60_000))).toMatch(/h ago$/);
    expect(formatRelativeTime(new Date(NOW - 2 * 24 * 60 * 60_000))).toMatch(/d ago$/);
  });
});

describe("cn", () => {
  it("merges tailwind classes deduplicating conflicts", () => {
    // tailwind-merge resolves p-2 vs p-4 to the last one
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("drops falsy values", () => {
    expect(cn("a", false && "b", null, undefined, "c")).toBe("a c");
  });
});
