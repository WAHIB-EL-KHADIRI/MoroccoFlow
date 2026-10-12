/**
 * The real auth routes on a real PostgreSQL: bootstrap, login, lockout, MFA, refresh
 * rotation, logout and invitations. Nothing is stubbed except the rate limiter, which
 * buildApp({ infrastructure: false }) leaves out. TOTP codes are computed here by an
 * independent RFC 6238 implementation, so the test does not just echo the production code.
 */
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { authenticationPlugin } from "../src/plugins/authentication.js";
import { auditPlugin } from "../src/plugins/audit.js";
import { databasePlugin } from "../src/plugins/database.js";
import { authRoutes } from "../src/modules/auth/routes.js";
import { teamRoutes } from "../src/modules/team/routes.js";
import { createMfaSecret, encryptMfaSecret, hashPassword } from "../src/lib/crypto.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totp(secret, at = Date.now()) {
  let bits = "";
  for (const char of secret) bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, i) =>
      Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2),
    ),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}
const wrongCode = (secret) => {
  const valid = [-1, 0, 1].map((w) => totp(secret, Date.now() + w * 30_000));
  return ["111111", "222222", "333333"].find((c) => !valid.includes(c));
};

suite("auth on PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const tag = randomUUID().slice(0, 8);
  const workspace = `auth-${tag}`;
  const ownerEmail = `owner-${tag}@example.test`;
  const OWNER_PASSWORD = "Owner-Passw0rd!2026";
  const USER_PASSWORD = "Member-Passw0rd!2026";
  const tenants = [];
  let app;
  let tenantId;
  let seq = 0;

  const post = (url, payload, extra = {}) =>
    app.inject({ method: "POST", url: `/api/v1${url}`, payload, ...extra });
  const login = (email, password, extra = {}) =>
    post("/auth/login", { workspace, email, password, ...extra });
  const refreshCookie = (response) => response.cookies.find((c) => c.name === "mf_refresh");
  const bearer = (response) => ({ authorization: `Bearer ${response.json().data.accessToken}` });
  const row = async (email) =>
    (await pool.query("SELECT * FROM users WHERE email = $1", [email])).rows[0];

  async function makeUser({ role = "viewer", status = "active", password = USER_PASSWORD } = {}) {
    seq += 1;
    const email = `u${seq}-${tag}@example.test`;
    await pool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), tenantId, email, await hashPassword(password), `User ${seq}`, role, status],
    );
    return email;
  }

  async function enableMfa(email) {
    const secret = createMfaSecret();
    await pool.query(
      "UPDATE users SET mfa_secret_encrypted = $2, mfa_enabled = true WHERE email = $1",
      [email, encryptMfaSecret(secret, app.config.mfaEncryptionKey)],
    );
    return secret;
  }

  beforeAll(async () => {
    app = await buildApp({ infrastructure: false, logger: false });
    await databasePlugin(app, { config: { ...app.config, databaseUrl } });
    await authenticationPlugin(app, { config: app.config });
    await auditPlugin(app);
    await app.register(authRoutes, { prefix: "/api/v1/auth" });
    await app.register(teamRoutes, { prefix: "/api/v1" });
    await app.ready();
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const probe = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
      if (probe.statusCode !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
      for (const id of tenants) {
        await pool.query("DELETE FROM audit_logs WHERE tenant_id = $1", [id]);
        await pool.query("DELETE FROM user_invitations WHERE tenant_id = $1", [id]);
        await pool.query("DELETE FROM tenants WHERE id = $1", [id]);
      }
    } finally {
      await pool.end();
    }
  });

  describe("bootstrap", () => {
    const body = () => ({
      workspace,
      companyName: "Auth Test SARL",
      ownerName: "Owner Name",
      email: ownerEmail,
      password: OWNER_PASSWORD,
    });

    it("is invisible without the bootstrap token", async () => {
      expect((await post("/auth/bootstrap", body())).statusCode).toBe(404);
      const wrong = await post("/auth/bootstrap", body(), {
        headers: { "x-bootstrap-token": "wrong-token" },
      });
      expect(wrong.statusCode).toBe(404);
    });

    it("rejects a weak owner password", async () => {
      const response = await post(
        "/auth/bootstrap",
        { ...body(), password: "alllowercase12" },
        { headers: { "x-bootstrap-token": app.config.bootstrapToken } },
      );
      expect(response.statusCode).toBe(400);
    });

    it("creates the workspace and its owner, once", async () => {
      const headers = { "x-bootstrap-token": app.config.bootstrapToken };
      const created = await post("/auth/bootstrap", body(), { headers });
      expect(created.statusCode, created.body).toBe(201);
      tenantId = created.json().data.tenantId;
      tenants.push(tenantId);
      expect((await row(ownerEmail)).role).toBe("owner");

      const again = await post("/auth/bootstrap", body(), { headers });
      expect(again.statusCode).toBe(409);
    });
  });

  describe("login", () => {
    it("issues an access token and a hardened refresh cookie", async () => {
      const response = await login(ownerEmail, OWNER_PASSWORD);

      expect(response.statusCode, response.body).toBe(200);
      const cookie = refreshCookie(response);
      expect(cookie.httpOnly).toBe(true);
      expect(String(cookie.sameSite).toLowerCase()).toBe("strict");
      expect(cookie.path).toBe("/api/v1/auth");
      const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(response) });
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json().data.email).toBe(ownerEmail);
      expect(me.json().data.permissions).toEqual(["*"]);
    });

    it("does not reveal whether the workspace, the email or the password was wrong", async () => {
      const wrongPassword = await login(ownerEmail, "Wrong-Passw0rd!2026");
      const unknownEmail = await login(`nobody-${tag}@example.test`, OWNER_PASSWORD);
      const unknownWorkspace = await post("/auth/login", {
        workspace: `missing-${tag}`,
        email: ownerEmail,
        password: OWNER_PASSWORD,
      });

      for (const response of [wrongPassword, unknownEmail, unknownWorkspace]) {
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
      }
      expect(unknownEmail.json().error.message).toBe(wrongPassword.json().error.message);
      expect(unknownWorkspace.json().error.message).toBe(wrongPassword.json().error.message);
    });

    it("treats the email case-insensitively", async () => {
      expect((await login(ownerEmail.toUpperCase(), OWNER_PASSWORD)).statusCode).toBe(200);
    });

    it("refuses an archived account even with the right password", async () => {
      const email = await makeUser({ status: "archived" });

      expect((await login(email, USER_PASSWORD)).statusCode).toBe(401);
    });

    it("locks the account after five wrong passwords, even for the right one", async () => {
      const email = await makeUser();
      for (let i = 0; i < 5; i += 1) {
        expect((await login(email, "Wrong-Passw0rd!2026")).statusCode).toBe(401);
      }

      const locked = await login(email, USER_PASSWORD);

      expect(locked.statusCode).toBe(423);
      expect(locked.json().error.code).toBe("ACCOUNT_LOCKED");
      await pool.query("UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = $1", [email]);
      expect((await login(email, USER_PASSWORD)).statusCode).toBe(200);
    });

    it("resets the failure counter on a successful login", async () => {
      const email = await makeUser();
      for (let i = 0; i < 3; i += 1) await login(email, "Wrong-Passw0rd!2026");
      expect((await row(email)).failed_login_count).toBe(3);

      expect((await login(email, USER_PASSWORD)).statusCode).toBe(200);

      expect((await row(email)).failed_login_count).toBe(0);
    });
  });

  describe("multi-factor authentication", () => {
    it("requires a valid code once MFA is enabled", async () => {
      const email = await makeUser();
      const secret = await enableMfa(email);

      const missing = await login(email, USER_PASSWORD);
      const wrong = await login(email, USER_PASSWORD, { mfaCode: wrongCode(secret) });
      const right = await login(email, USER_PASSWORD, { mfaCode: totp(secret) });

      expect([missing.statusCode, wrong.statusCode]).toEqual([403, 403]);
      expect(missing.json().error.code).toBe("MFA_REQUIRED");
      expect(right.statusCode, right.body).toBe(200);
    });

    it("counts wrong codes as failed attempts and locks the account", async () => {
      const email = await makeUser();
      const secret = await enableMfa(email);
      for (let i = 0; i < 5; i += 1) {
        const response = await login(email, USER_PASSWORD, { mfaCode: wrongCode(secret) });
        expect(response.statusCode).toBe(403);
      }

      const afterGuessing = await login(email, USER_PASSWORD, { mfaCode: totp(secret) });

      expect(afterGuessing.statusCode).toBe(423);
      expect((await row(email)).failed_login_count).toBeGreaterThanOrEqual(5);
    });

    it("can be set up, confirmed and disabled through the API", async () => {
      const email = await makeUser();
      const session = await login(email, USER_PASSWORD);
      const headers = bearer(session);

      const setup = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/setup", headers });
      const { secret, otpauthUri } = setup.json().data;
      expect(otpauthUri).toContain(`secret=${secret}`);
      expect(
        (await post("/auth/mfa/confirm", { code: wrongCode(secret) }, { headers })).statusCode,
      ).toBe(400);
      expect((await post("/auth/mfa/confirm", { code: totp(secret) }, { headers })).statusCode).toBe(204);
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/mfa/setup", headers })).statusCode).toBe(409);

      const badDisable = await post(
        "/auth/mfa/disable",
        { password: "Wrong-Passw0rd!2026", code: totp(secret) },
        { headers },
      );
      expect(badDisable.statusCode).toBe(403);
      const disabled = await post(
        "/auth/mfa/disable",
        { password: USER_PASSWORD, code: totp(secret) },
        { headers },
      );
      expect(disabled.statusCode, disabled.body).toBe(204);
      expect((await login(email, USER_PASSWORD)).statusCode).toBe(200);
    });

    it("never stores the MFA secret in clear text", async () => {
      const email = await makeUser();
      const secret = await enableMfa(email);

      const stored = (await row(email)).mfa_secret_encrypted;

      expect(Buffer.from(stored).toString("utf8")).not.toContain(secret);
    });
  });

  describe("refresh and logout", () => {
    it("rotates the refresh token and rejects the old one", async () => {
      const email = await makeUser();
      const first = await login(email, USER_PASSWORD);
      const oldCookie = refreshCookie(first).value;

      const rotated = await post("/auth/refresh", undefined, { cookies: { mf_refresh: oldCookie } });
      expect(rotated.statusCode, rotated.body).toBe(200);
      expect(refreshCookie(rotated).value).not.toBe(oldCookie);

      const reused = await post("/auth/refresh", undefined, { cookies: { mf_refresh: oldCookie } });
      expect(reused.statusCode).toBe(401);
    });

    it("needs a refresh cookie and refuses a foreign origin", async () => {
      const email = await makeUser();
      const session = await login(email, USER_PASSWORD);

      expect((await post("/auth/refresh")).statusCode).toBe(401);
      const foreign = await post("/auth/refresh", undefined, {
        cookies: { mf_refresh: refreshCookie(session).value },
        headers: { origin: "https://evil.example.test" },
      });
      expect(foreign.statusCode).toBe(403);
    });

    it("does not refresh a session whose account was archived", async () => {
      const email = await makeUser();
      const session = await login(email, USER_PASSWORD);
      await pool.query("UPDATE users SET status = 'archived' WHERE email = $1", [email]);

      const response = await post("/auth/refresh", undefined, {
        cookies: { mf_refresh: refreshCookie(session).value },
      });

      expect(response.statusCode).toBe(401);
    });

    it("logout revokes the refresh token", async () => {
      const email = await makeUser();
      const session = await login(email, USER_PASSWORD);
      const cookie = refreshCookie(session).value;

      const out = await post("/auth/logout", undefined, {
        headers: bearer(session),
        cookies: { mf_refresh: cookie },
      });
      expect(out.statusCode).toBe(204);

      const after = await post("/auth/refresh", undefined, { cookies: { mf_refresh: cookie } });
      expect(after.statusCode).toBe(401);
    });

    it("rejects unauthenticated calls to protected auth routes", async () => {
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
      expect((await post("/auth/logout")).statusCode).toBe(401);
      expect((await post("/auth/mfa/setup")).statusCode).toBe(401);
    });
  });

  describe("invitations", () => {
    async function invite(role = "sales") {
      const owner = await login(ownerEmail, OWNER_PASSWORD);
      seq += 1;
      const email = `invitee${seq}-${tag}@example.test`;
      const response = await post(
        "/team/invitations",
        { email, fullName: "Invited Person", role },
        { headers: bearer(owner) },
      );
      expect(response.statusCode, response.body).toBe(201);
      return { email, token: response.json().data.invitationToken, id: response.json().data.id };
    }

    it("lets the invitee set a password once, with the invited role", async () => {
      const { email, token } = await invite("sales");

      const accepted = await post("/auth/accept-invitation", { token, password: USER_PASSWORD });
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect((await row(email)).role).toBe("sales");
      expect((await login(email, USER_PASSWORD)).statusCode).toBe(200);

      const again = await post("/auth/accept-invitation", { token, password: USER_PASSWORD });
      expect(again.statusCode).toBe(400);
      expect(again.json().error.code).toBe("INVALID_INVITATION");
    });

    it("rejects a weak password without consuming the invitation", async () => {
      const { token } = await invite();

      expect((await post("/auth/accept-invitation", { token, password: "short" })).statusCode).toBe(400);
      expect((await post("/auth/accept-invitation", { token, password: USER_PASSWORD })).statusCode).toBe(201);
    });

    it("rejects an unknown token and an expired invitation", async () => {
      const unknown = await post("/auth/accept-invitation", {
        token: "x".repeat(64),
        password: USER_PASSWORD,
      });
      expect(unknown.statusCode).toBe(400);

      const { token, id } = await invite();
      await pool.query("UPDATE user_invitations SET expires_at = now() - interval '1 hour' WHERE id = $1", [id]);
      const expired = await post("/auth/accept-invitation", { token, password: USER_PASSWORD });
      expect(expired.statusCode).toBe(400);
      expect(expired.json().error.code).toBe("INVALID_INVITATION");
    });
  });
});
