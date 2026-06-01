import { describe, it, expect } from "vitest";
import { parseLabels } from "../agent/src/docker";

describe("parseLabels", () => {
  it("extracts compose project + service from the standard labels", () => {
    const raw =
      "com.docker.compose.project=media,com.docker.compose.service=jellyfin,foo=bar";
    expect(parseLabels(raw)).toEqual({ project: "media", service: "jellyfin" });
  });

  it("returns empty object for missing labels", () => {
    expect(parseLabels("")).toEqual({});
    expect(parseLabels("foo=bar")).toEqual({});
  });

  it("ignores malformed pairs without crashing", () => {
    expect(parseLabels("no-equals,com.docker.compose.project=ok")).toEqual({
      project: "ok",
    });
  });
});
