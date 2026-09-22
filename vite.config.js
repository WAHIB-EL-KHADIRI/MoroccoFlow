import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE_PATH || "/",
  build: {
    target: "baseline-widely-available",
    cssCodeSplit: true,
    // "hidden" still emits the maps, so a stack trace can be symbolicated by
    // uploading them to an error tracker, but drops the //# sourceMappingURL
    // comment from the bundles. Without that comment a visitor's devtools will
    // not fetch them, and the original source is not handed to everyone who
    // opens the deployed site -- which `true` does, and which would make the
    // licence a formality. Do not ship the .map files themselves.
    sourcemap: "hidden",
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
