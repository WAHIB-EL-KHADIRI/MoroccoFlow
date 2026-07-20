import { describe, expect, it } from "vitest";
import { can } from "../src/lib/rbac.js";
import {
  createMfaSecret,
  createOpaqueToken,
  decryptMfaSecret,
  encryptMfaSecret,
  hashPassword,
  hashToken,
  safeTokenEqual,
  verifyPassword,
  verifyTotp,
} from "../src/lib/crypto.js";
import { decodeCursor, encodeCursor, toPublicJson } from "../src/lib/serialize.js";

describe("security primitives", () => {
  it("enforces permissions by role and namespace", () => {
    expect(can("owner", "settings:write")).toBe(true);
    expect(can("finance", "finance:write")).toBe(true);
    expect(can("viewer", "finance:write")).toBe(false);
    expect(can("unknown", "crm:read")).toBe(false);
  });

  it("hashes and verifies passwords with Argon2id", async () => {
    const hash = await hashPassword("A-company-password-2026!");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "A-company-password-2026!")).toBe(true);
    expect(await verifyPassword(hash, "incorrect")).toBe(false);
  });

  it("encrypts MFA secrets and verifies an RFC TOTP vector", () => {
    const key = "a".repeat(64);
    const secret = createMfaSecret();
    const encrypted = encryptMfaSecret(secret, key);
    expect(encrypted.toString("utf8")).not.toContain(secret);
    expect(decryptMfaSecret(encrypted, key)).toBe(secret);
    expect(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", 59_000)).toBe(true);
  });
  it("creates and compares opaque token hashes", () => {
    const token = createOpaqueToken();
    expect(token.length).toBeGreaterThan(40);
    expect(hashToken(token)).toHaveLength(64);
    expect(safeTokenEqual(token, token)).toBe(true);
    expect(safeTokenEqual(token, `${token}x`)).toBe(false);
  });
});

describe("public serialization", () => {
  it("converts database keys and round-trips pagination cursors", () => {
    const row = {
      id: "ee4c6841-b4cf-4f54-bf23-2c6087ecc38b",
      updated_at: "2026-07-20T10:00:00.000Z",
    };
    expect(toPublicJson({ tenant_id: "tenant" })).toEqual({ tenantId: "tenant" });
    expect(decodeCursor(encodeCursor(row))).toEqual({ updatedAt: row.updated_at, id: row.id });
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
});
