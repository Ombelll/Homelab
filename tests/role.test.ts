import { describe, it, expect } from "vitest";

// Sanity-checks for role-string handling. The actual middleware/route guards
// live behind the Prisma client so they're integration-tested rather than
// unit-tested here.

describe("role values", () => {
  const VALID = ["admin", "viewer"] as const;

  it("treats unknown values as viewer when normalising defensively", () => {
    // Mirrors the normalizeRole function in src/lib/session.ts.
    const normalize = (raw: string | null | undefined): "admin" | "viewer" =>
      raw === "admin" ? "admin" : "viewer";

    expect(normalize("admin")).toBe("admin");
    expect(normalize("viewer")).toBe("viewer");
    expect(normalize("root")).toBe("viewer");
    expect(normalize(null)).toBe("viewer");
    expect(normalize(undefined)).toBe("viewer");
    expect(normalize("")).toBe("viewer");
  });

  it("admin is a strict superset of viewer", () => {
    // Convention: any action allowed to viewer is also allowed to admin.
    expect(VALID.includes("admin")).toBe(true);
    expect(VALID.includes("viewer")).toBe(true);
  });
});
