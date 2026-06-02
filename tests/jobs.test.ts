import { describe, it, expect } from "vitest";
import { parseResult, JOB_TYPES } from "@/lib/jobs";

describe("parseResult", () => {
  it("returns null for null input", () => {
    expect(parseResult(null)).toBeNull();
  });

  it("parses valid JSON", () => {
    expect(parseResult('{"lines":["a","b"]}')).toEqual({ lines: ["a", "b"] });
  });

  it("falls back to raw string for invalid JSON", () => {
    expect(parseResult("not-json")).toBe("not-json");
  });
});

describe("JOB_TYPES allowlist", () => {
  it("matches the documented action set", () => {
    expect([...JOB_TYPES].sort()).toEqual(
      [
        "agent.update",
        "container.logs",
        "container.logs.stream",
        "container.restart",
        "container.start",
        "container.stop",
      ].sort(),
    );
  });
});
