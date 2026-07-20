import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://database/moroccoflow",
  REDIS_URL: "rediss://redis.example/0",
  JWT_SECRET: "j".repeat(64),
  COOKIE_SECRET: "c".repeat(48),
  BOOTSTRAP_TOKEN: "b".repeat(48),
  S3_ENDPOINT: "https://s3.example.com",
  S3_ACCESS_KEY_ID: "access",
  S3_SECRET_ACCESS_KEY: "secret",
  S3_BUCKET: "documents",
  FILE_SCAN_TOKEN: "f".repeat(48),
  MFA_ENCRYPTION_KEY: "a".repeat(64),
};

describe("production configuration", () => {
  it("rejects missing required configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      /Missing production configuration/,
    );
  });

  it("requires long signing secrets and enables secure defaults", () => {
    const config = loadConfig(production);
    expect(config.isProduction).toBe(true);
    expect(config.fileScanningRequired).toBe(true);
    expect(config.s3.serverSideEncryption).toBe("AES256");
    expect(Object.isFrozen(config)).toBe(true);
  });
});
