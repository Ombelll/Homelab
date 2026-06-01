import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate config so `npm test` stays fast and unit-only. Integration tests
// use a real SQLite DB and the actual Prisma client; they cost ~1s each.
//
// Run with:  npm run test:integration
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
