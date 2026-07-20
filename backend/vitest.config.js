import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "../coverage/backend",
    },
  },
});
