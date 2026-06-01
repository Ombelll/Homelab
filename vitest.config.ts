import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests live under tests/integration and have their own
    // config (vitest.integration.config.ts) with the DB setup. Exclude
    // them here so `npm test` stays unit-only and fast.
    exclude: ["tests/integration/**", "node_modules/**", ".next/**"],
    environment: "node",
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
