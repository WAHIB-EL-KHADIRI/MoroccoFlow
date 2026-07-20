import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "coverage/**", "playwright-report/**", "test-results/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2026,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["backend/**/*.js"],
    languageOptions: {
      ecmaVersion: 2026,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.js", "scripts/**/*.mjs", "*.config.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
];
