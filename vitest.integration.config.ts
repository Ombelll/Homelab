import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate config so `npm test` stays fast and unit-only. Integration tests
// use a real Postgres DB (a throwaway schema, see tests/integration/setup.ts)
// and the actual Prisma client.
//
// Run with:  TEST_DATABASE_URL=postgresql://user:pass@host:5432/db npm run test:integration
// Without a Postgres URL the suite skips itself cleanly.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: false,
    globalSetup: ["tests/integration/setup.ts"],
    // Each test file gets its own DB file so they can run in parallel
    // without stepping on each other.
    pool: "forks",
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
