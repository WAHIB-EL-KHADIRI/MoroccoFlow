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
      // Measured in CI with PostgreSQL: 84.3% statements, 77.5% branches, 90.2% functions,
      // 85.6% lines. Set just under so it cannot regress; raise as tests are added. Only
      // enforced when run with --coverage; without TEST_DATABASE_URL the integration suites
      // are skipped and the numbers are much lower.
      thresholds: { statements: 80, branches: 70, functions: 85, lines: 80 },
    },
  },
});
