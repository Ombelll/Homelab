import { describe, it, expect } from "vitest";
// Pure-function parsers from the agent. Imported by relative path because the
// agent is a separate package with its own tsconfig — the test runner picks
// them up via the source file directly.
import { normalizeStatus, parsePorts, parseHealth } from "../agent/src/docker";

describe("parseHealth", () => {
  it("extracts the healthcheck state from the Status string", () => {
    expect(parseHealth("Up 2 hours (healthy)")).toBe("healthy");
    expect(parseHealth("Up 5 minutes (unhealthy)")).toBe("unhealthy");
    expect(parseHealth("Up Less than a second (health: starting)")).toBe("starting");
  });

  it("returns undefined when the image has no healthcheck", () => {
    expect(parseHealth("Up 2 hours")).toBeUndefined();
    expect(parseHealth("Exited (0) 1 minute ago")).toBeUndefined();
    expect(parseHealth("")).toBeUndefined();
  });
});

describe("normalizeStatus", () => {
  it("maps 'Up 5 minutes' → 'running'", () => {
    expect(normalizeStatus("Up 5 minutes")).toBe("running");
    expect(normalizeStatus("running")).toBe("running");
  });

  it("maps exited / restarting / paused / dead / created", () => {
    expect(normalizeStatus("Exited (0) 1 minute ago")).toBe("exited");
    expect(normalizeStatus("Restarting (1) 3 seconds ago")).toBe("restarting");
    expect(normalizeStatus("Paused")).toBe("paused");
    expect(normalizeStatus("Dead")).toBe("dead");
    expect(normalizeStatus("Created")).toBe("created");
  });

  it("returns 'unknown' for empty input", () => {
    expect(normalizeStatus("")).toBe("unknown");
  });
});

describe("parsePorts", () => {
  it("returns an empty array for empty input", () => {
    expect(parsePorts("")).toEqual([]);
  });

  it("parses host-mapped port", () => {
    expect(parsePorts("0.0.0.0:8080->80/tcp")).toEqual([
      { host: "8080", container: "80", protocol: "tcp" },
    ]);
  });

  it("parses unmapped port", () => {
    expect(parsePorts("5432/tcp")).toEqual([
      { host: undefined, container: "5432", protocol: "tcp" },
    ]);
  });

  it("collapses IPv4 + IPv6 duplicates", () => {
    const out = parsePorts("0.0.0.0:8080->80/tcp, :::8080->80/tcp");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ host: "8080", container: "80", protocol: "tcp" });
  });

  it("ignores garbage segments instead of throwing", () => {
    expect(parsePorts("nonsense, 5432/tcp")).toEqual([
      { host: undefined, container: "5432", protocol: "tcp" },
    ]);
  });
});
