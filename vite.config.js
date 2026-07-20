import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE_PATH || "/",
  build: {
    target: "baseline-widely-available",
    cssCodeSplit: true,
    sourcemap: true,
    reportCompressedSize: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  preview: {
    host: "127.0.0.1",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    include: ["tests/unit/**/*.test.js", "tests/integration/**/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        lines: 80,
        functions: 70,
        statements: 80,
        branches: 75,
      },
    },
  },
});
