/**
 * Team routes on a real PostgreSQL with RLS: who can invite or change whom.
 * Same harness as the quote suites; stored state is read as the superuser.
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { authenticationPlugin } from "../src/plugins/authentication.js";
import { auditPlugin } from "../src/plugins/audit.js";
import { databasePlugin } from "../src/plugins/database.js";
import { signAccessToken } from "../src/modules/auth/routes.js";
import { teamRoutes } from "../src/modules/team/routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("team routes on PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const roles = {
    ownerA: [tenantA, "owner"],
    adminA: [tenantA, "admin"],
    hrA: [tenantA, "hr"],
    salesA: [tenantA, "sales"],
    viewerA: [tenantA, "viewer"],
    ownerB: [tenantB, "owner"],
  };
  const users = Object.fromEntries(Object.keys(roles).map((key) => [key, randomUUID()]));
  const tokens = {};
  let app;
  let seq = 0;

  const api = (who, method, url, payload) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${tokens[who]}` },
      payload,
    });
  const stored = async (key) =>
    (await pool.query("SELECT * FROM users WHERE id = $1", [users[key]])).rows[0];
  const invite = (who, role) => {
    seq += 1;
    return api(who, "POST", "/team/invitations", {
      email: `new${seq}-${tenantA.slice(0, 6)}@example.test`,
      fullName: "New Member",
      role,
    });
  };

  beforeAll(async () => {
    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      tenantA,
      `ta-${tenantA.slice(0, 8)}`,
      tenantB,
      `tb-${tenantB.slice(0, 8)}`,
    ]);
    for (const [key, [tenantId, role]] of Object.entries(roles)) {
      await pool.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'x', $4, $5)`,
        [users[key], tenantId, `${key}-${users[key]}@example.test`, key, role],
      );
    }

    app = await buildApp({ infrastructure: false, logger: false });
    await databasePlugin(app, { config: { ...app.config, databaseUrl } });
    await authenticationPlugin(app, { config: app.config });
    await auditPlugin(app);
    await app.register(teamRoutes, { prefix: "/api/v1" });
    await app.ready();
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const probe = await app.inject({ method: "GET", url: "/api/v1/team" });
      if (probe.statusCode !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const [key, [tenantId, role]] of Object.entries(roles)) {
      tokens[key] = signAccessToken(app, {
        userId: users[key],
        tenantId,
        role,
        sessionId: randomUUID(),
      });
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
      for (const tenant of [tenantA, tenantB]) {
        await pool.query("DELETE FROM audit_logs WHERE tenant_id = $1", [tenant]);
        await pool.query("DELETE FROM user_invitations WHERE tenant_id = $1", [tenant]);
        await pool.query("DELETE FROM tenants WHERE id = $1", [tenant]);
      }
    } finally {
      await pool.end();
    }
  });

  describe("listing", () => {
    it("lists the members of the caller's company only", async () => {
      const response = await api("viewerA", "GET", "/team");

      expect(response.statusCode, response.body).toBe(200);
      const ids = response.json().data.map((member) => member.id);
      expect(ids).toContain(users.ownerA);
      expect(ids).not.toContain(users.ownerB);
    });

    it("never returns password hashes", async () => {
      const response = await api("viewerA", "GET", "/team");

      expect(JSON.stringify(response.json())).not.toMatch(/password/i);
    });
  });

  describe("invitations", () => {
    it("lets an admin invite roles up to their own level and stores only the token hash", async () => {
      for (const role of ["admin", "hr", "sales", "viewer"]) {
        const response = await invite("adminA", role);
        expect(response.statusCode, `${role}: ${response.body}`).toBe(201);
      }
      const response = await invite("adminA", "sales");
      const { invitationToken, email } = response.json().data;
      const row = (await pool.query("SELECT token_hash FROM user_invitations WHERE email = $1", [email]))
        .rows[0];

      expect(invitationToken).toBeTruthy();
      expect(row.token_hash).not.toContain(invitationToken);
    });

    it("refuses hr inviting an admin, or any role with business access", async () => {
      for (const role of ["admin", "sales", "finance", "project_manager", "viewer"]) {
        const response = await invite("hrA", role);
        expect(response.statusCode, `${role}: ${response.body}`).toBe(403);
        expect(response.json().error.code).toBe("ROLE_ESCALATION");
      }
    });

    it("still lets hr invite another hr member", async () => {
      expect((await invite("hrA", "hr")).statusCode).toBe(201);
    });

    it("refuses a duplicate member email", async () => {
      const response = await api("adminA", "POST", "/team/invitations", {
        email: (await stored("salesA")).email,
        fullName: "Dup Licate",
        role: "sales",
      });

      expect(response.statusCode).toBe(409);
    });

    it("rejects the owner role at the schema level", async () => {
      const response = await invite("ownerA", "owner");

      expect(response.statusCode).toBe(400);
    });

    it("writes an audit entry", async () => {
      const response = await invite("adminA", "viewer");
      const id = response.json().data.id;
      const audit = await pool.query(
        "SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'invitation.created'",
        [id],
      );

      expect(audit.rowCount).toBe(1);
    });
  });

  describe("changing a member", () => {
    it("refuses hr promoting a member to admin", async () => {
      const before = await stored("viewerA");

      const response = await api("hrA", "PATCH", `/team/${users.viewerA}`, {
        version: before.version,
        role: "admin",
      });

      expect(response.statusCode, response.body).toBe(403);
      expect((await stored("viewerA")).role).toBe("viewer");
    });

    it("refuses hr changing a member whose role is above hr", async () => {
      const before = await stored("adminA");

      const response = await api("hrA", "PATCH", `/team/${users.adminA}`, {
        version: before.version,
        status: "archived",
      });

      expect(response.statusCode, response.body).toBe(403);
      expect((await stored("adminA")).status).toBe("active");
    });

    it("refuses an admin demoting or archiving the owner", async () => {
      const before = await stored("ownerA");

      for (const patch of [{ role: "viewer" }, { status: "archived" }, { department: "x" }]) {
        const response = await api("adminA", "PATCH", `/team/${users.ownerA}`, {
          version: before.version,
          ...patch,
        });
        expect(response.statusCode, JSON.stringify(patch)).toBe(403);
      }
      const after = await stored("ownerA");
      expect([after.role, after.status]).toEqual(["owner", "active"]);
    });

    it("lets the owner promote a member to admin", async () => {
      const before = await stored("salesA");

      const response = await api("ownerA", "PATCH", `/team/${users.salesA}`, {
        version: before.version,
        role: "admin",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect((await stored("salesA")).role).toBe("admin");
      // put it back so the other cases keep their fixture
      const mid = await stored("salesA");
      await api("ownerA", "PATCH", `/team/${users.salesA}`, { version: mid.version, role: "sales" });
    });

    it("lets an admin change a department", async () => {
      const before = await stored("viewerA");

      const response = await api("adminA", "PATCH", `/team/${users.viewerA}`, {
        version: before.version,
        department: "Sales ops",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect((await stored("viewerA")).department).toBe("Sales ops");
    });

    it("answers 409 for a stale version", async () => {
      const before = await stored("viewerA");

      const response = await api("adminA", "PATCH", `/team/${users.viewerA}`, {
        version: before.version + 50,
        department: "Late",
      });

      expect(response.statusCode).toBe(409);
    });

    it("refuses changing your own role or archiving yourself", async () => {
      const before = await stored("adminA");

      for (const patch of [{ role: "viewer" }, { status: "archived" }]) {
        const response = await api("adminA", "PATCH", `/team/${users.adminA}`, {
          version: before.version,
          ...patch,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("SELF_ACCESS_CHANGE");
      }
    });

    it("cannot reach a member of another company", async () => {
      const before = await stored("viewerA");

      const response = await api("ownerB", "PATCH", `/team/${users.viewerA}`, {
        version: before.version,
        department: "Hijack",
      });

      expect(response.statusCode).toBe(409);
      expect((await stored("viewerA")).department).not.toBe("Hijack");
    });

    it("revokes the member's refresh tokens when their access changes", async () => {
      await pool.query(
        `INSERT INTO refresh_tokens (id, tenant_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
        [randomUUID(), tenantA, users.viewerA, createHash("sha256").update(randomUUID()).digest("hex")],
      );
      const before = await stored("viewerA");

      const response = await api("adminA", "PATCH", `/team/${users.viewerA}`, {
        version: before.version,
        department: "Revoke check",
      });

      expect(response.statusCode, response.body).toBe(200);
      const open = await pool.query(
        "SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL",
        [users.viewerA],
      );
      expect(open.rows[0].n).toBe(0);
    });
  });
});
