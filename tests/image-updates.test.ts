import { describe, it, expect } from "vitest";
import { parseImageRef } from "@/lib/image-updates";

describe("parseImageRef", () => {
  it("expands bare official images to docker.io/library", () => {
    expect(parseImageRef("nginx")).toEqual({
      registry: "docker.io",
      repository: "library/nginx",
      tag: "latest",
    });
  });

  it("preserves docker.io user images", () => {
    expect(parseImageRef("grafana/grafana:9.5")).toEqual({
      registry: "docker.io",
      repository: "grafana/grafana",
      tag: "9.5",
    });
  });

  it("recognises non-docker.io registries via dot/colon in first segment", () => {
    expect(parseImageRef("ghcr.io/foo/bar:dev")).toEqual({
      registry: "ghcr.io",
      repository: "foo/bar",
      tag: "dev",
    });
    expect(parseImageRef("localhost:5000/private:1")).toEqual({
      registry: "localhost:5000",
      repository: "private",
      tag: "1",
    });
  });

  it("defaults tag to latest when none given", () => {
    expect(parseImageRef("grafana/grafana")).toEqual({
      registry: "docker.io",
      repository: "grafana/grafana",
      tag: "latest",
    });
  });

  it("returns null for empty input", () => {
    expect(parseImageRef("")).toBeNull();
  });
});
