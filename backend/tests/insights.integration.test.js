/**
 * Dashboard, notifications, audit log and the finance CSV on a real PostgreSQL with RLS.
 * Same harness as the other integration suites; stored state is seeded and read as the
 * superuser so assertions cannot be fooled by the RLS context under test.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { authenticationPlugin } from "../src/plugins/authentication.js";
import { auditPlugin } from "../src/plugins/audit.js";
import { databasePlugin } from "../src/plugins/database.js";
import { signAccessToken } from "../src/modules/auth/routes.js";
import { insightRoutes } from "../src/modules/insights/routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("insights on PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const roles = {
    ownerA: [tenantA, "owner"],
    adminA: [tenantA, "admin"],
    financeA: [tenantA, "finance"],
    salesA: [tenantA, "sales"],
    hrA: [tenantA, "hr"],
    viewerA: [tenantA, "viewer"],
    ownerB: [tenantB, "owner"],
  };
  const users = Object.fromEntries(Object.keys(roles).map((key) => [key, randomUUID()]));
  const clientA = randomUUID();
  const clientB = randomUUID();
  const tokens = {};
  let app;

  const get = (who, url) =>
    app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokens[who]}` } });
  const send = (who, method, url, payload) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${tokens[who]}` },
      payload,
    });

  const invoice = (tenant, client, number, status, subtotal, paid, issueDate) =>
    pool.query(
      `INSERT INTO invoices (tenant_id, client_id, number, issue_date, due_date, status,
                             subtotal_cents, tax_cents, paid_cents)
       VALUES ($1, $2, $3, $4::date, $4::date + 30, $5, $6, 0, $7)`,
      [tenant, client, number, issueDate, status, subtotal, paid],
    );

  beforeAll(async () => {
    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      tenantA,
      `ia-${tenantA.slice(0, 8)}`,
      tenantB,
      `ib-${tenantB.slice(0, 8)}`,
    ]);
    for (const [key, [tenantId, role]] of Object.entries(roles)) {
      await pool.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'x', $4, $5)`,
        [users[key], tenantId, `${key}-${users[key]}@example.test`, key, role],
      );
    }
    await pool.query(
      `INSERT INTO clients (id, tenant_id, name, company) VALUES ($1, $2, 'Client A', 'A SARL'),
       ($3, $4, 'Client B', 'B SARL')`,
      [clientA, tenantA, clientB, tenantB],
    );
    await pool.query(
      `INSERT INTO clients (tenant_id, name, company, deleted_at) VALUES ($1, 'Gone', 'G SARL', now())`,
      [tenantA],
    );

    const today = (await pool.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0].d;
    await invoice(tenantA, clientA, "A-PAID", "paid", 100_000, 100_000, today);
    await invoice(tenantA, clientA, "A-SENT", "sent", 50_000, 20_000, today);
    await invoice(tenantA, clientA, "A-CANC", "cancelled", 70_000, 0, today);
    await invoice(tenantA, clientA, '=cmd|\' /C calc\'!A0', "sent", 1_000, 0, "2026-01-15");
    await invoice(tenantB, clientB, "B-PAID", "paid", 999_999, 999_999, today);
    await pool.query(
      `INSERT INTO expenses (tenant_id, label, category, expense_date, amount_cents)
       VALUES ($1, 'Fuel', 'transport', $2::date, 30000), ($3, 'Other tenant', 'x', $2::date, 777777)`,
      [tenantA, today, tenantB],
    );
    await pool.query(
      `INSERT INTO expenses (tenant_id, label, category, expense_date, amount_cents, deleted_at)
       VALUES ($1, 'Deleted', 'x', $2::date, 10000, now())`,
      [tenantA, today],
    );
    await pool.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type)
       VALUES ($1, $2, 'seed.a', 'x'), ($3, $4, 'seed.b', 'x')`,
      [tenantA, users.ownerA, tenantB, users.ownerB],
    );

    app = await buildApp({ infrastructure: false, logger: false });
    await databasePlugin(app, { config: { ...app.config, databaseUrl } });
    await authenticationPlugin(app, { config: app.config });
    await auditPlugin(app);
    await app.register(insightRoutes, { prefix: "/api/v1" });
    await app.ready();
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const probe = await app.inject({ method: "GET", url: "/api/v1/dashboard" });
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
        await pool.query("DELETE FROM tenants WHERE id = $1", [tenant]);
      }
    } finally {
      await pool.end();
    }
  });

  describe("dashboard", () => {
    it("adds up the company's own money and ignores deleted rows and other companies", async () => {
      const response = await get("viewerA", "/dashboard");

      expect(response.statusCode, response.body).toBe(200);
      const data = response.json().data;
      expect(Number(data.clients)).toBe(1); // the soft-deleted client is not counted
      expect(Number(data.teamMembers)).toBe(6);
      expect(Number(data.revenueCents)).toBe(100_000); // paid invoices only
      expect(Number(data.expensesCents)).toBe(30_000); // not the deleted or the other tenant's
      // sent 50 000 - 20 000 paid, plus the 1 000 sent: cancelled and paid are excluded
      expect(Number(data.outstandingCents)).toBe(31_000);
    });

    it("returns six months ending with the current one", async () => {
      const data = (await get("viewerA", "/dashboard")).json().data;

      expect(data.monthly).toHaveLength(6);
      const current = new Date().toISOString().slice(0, 7);
      expect(data.monthly.at(-1).month).toBe(current);
      expect(Number(data.monthly.at(-1).revenueCents)).toBe(100_000);
      expect(Number(data.monthly.at(-1).expensesCents)).toBe(30_000);
    });

    it("is closed to roles without reports access", async () => {
      expect((await get("hrA", "/dashboard")).statusCode).toBe(403);
    });

    it("shows another company its own figures, not this one's", async () => {
      const data = (await get("ownerB", "/dashboard")).json().data;

      expect(Number(data.revenueCents)).toBe(999_999);
      expect(Number(data.expensesCents)).toBe(777_777);
    });
  });

  describe("notifications", () => {
    const create = (who, payload) => send(who, "POST", "/notifications", payload);

    it("lets team managers create broadcast and personal notifications", async () => {
      const broadcast = await create("adminA", { type: "info", title: "Hello everyone" });
      const personal = await create("hrA", { type: "success", title: "For sales", userId: users.salesA });

      expect([broadcast.statusCode, personal.statusCode]).toEqual([201, 201]);
      expect(broadcast.json().data.userId).toBeNull();
    });

    it("refuses roles without team:write and invalid types", async () => {
      expect((await create("salesA", { type: "info", title: "x" })).statusCode).toBe(403);
      expect((await create("adminA", { type: "nope", title: "x" })).statusCode).toBe(400);
      expect((await create("adminA", { type: "info", title: "" })).statusCode).toBe(400);
    });

    it("shows a user broadcasts and their own, never someone else's", async () => {
      await create("adminA", { type: "info", title: "Visible to all" });
      await create("adminA", { type: "warning", title: "Only for viewer", userId: users.viewerA });
      await create("adminA", { type: "warning", title: "Only for sales", userId: users.salesA });

      const titles = (await get("viewerA", "/notifications")).json().data.map((n) => n.title);

      expect(titles).toContain("Visible to all");
      expect(titles).toContain("Only for viewer");
      expect(titles).not.toContain("Only for sales");
    });

    it("does not leak notifications across companies", async () => {
      await create("adminA", { type: "info", title: "Company A news" });

      const titles = (await get("ownerB", "/notifications")).json().data.map((n) => n.title);

      expect(titles).not.toContain("Company A news");
    });

    it("honours the limit", async () => {
      for (let i = 0; i < 3; i += 1) await create("adminA", { type: "info", title: `Bulk ${i}` });

      expect((await get("viewerA", "/notifications?limit=2")).json().data).toHaveLength(2);
      expect((await get("viewerA", "/notifications?limit=0")).statusCode).toBe(400);
    });

    it("marks your own notification read, and refuses someone else's", async () => {
      const mine = (await create("adminA", { type: "info", title: "Mine", userId: users.viewerA })).json().data;
      const theirs = (await create("adminA", { type: "info", title: "Theirs", userId: users.salesA })).json().data;

      const ok = await send("viewerA", "PATCH", `/notifications/${mine.id}/read`);
      const denied = await send("viewerA", "PATCH", `/notifications/${theirs.id}/read`);

      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().data.readAt).toBeTruthy();
      expect(denied.statusCode).toBe(404);
      const stored = await pool.query("SELECT read_at FROM notifications WHERE id = $1", [theirs.id]);
      expect(stored.rows[0].read_at).toBeNull();
    });

    it("answers 404 for an unknown notification and 400 for a malformed id", async () => {
      expect((await send("viewerA", "PATCH", `/notifications/${randomUUID()}/read`)).statusCode).toBe(404);
      expect((await send("viewerA", "PATCH", "/notifications/not-a-uuid/read")).statusCode).toBe(400);
    });

    it("does not answer 500 for a personal notification aimed at a user that does not exist", async () => {
      const response = await create("adminA", { type: "info", title: "Ghost", userId: randomUUID() });

      expect(response.statusCode).toBeLessThan(500);
    });
  });

  describe("audit log", () => {
    it("shows the company's entries with the actor's name", async () => {
      const response = await get("adminA", "/audit-log");

      expect(response.statusCode, response.body).toBe(200);
      const seeded = response.json().data.find((entry) => entry.action === "seed.a");
      expect(seeded.actorName).toBe("ownerA");
    });

    it("never shows another company's entries", async () => {
      const actions = (await get("adminA", "/audit-log")).json().data.map((entry) => entry.action);

      expect(actions).not.toContain("seed.b");
    });

    it("needs settings read access", async () => {
      expect((await get("salesA", "/audit-log")).statusCode).toBe(403);
    });
  });

  describe("finance export", () => {
    it("is a CSV attachment with a header, a BOM and plain ISO dates", async () => {
      const response = await get("financeA", "/exports/finance.csv");

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.headers["content-disposition"]).toContain("attachment");
      expect(response.body.startsWith("﻿")).toBe(true);
      const lines = response.body.slice(1).split("\r\n");
      expect(lines[0]).toBe("number,issue_date,due_date,status,total_cents,paid_cents,currency");
      expect(response.body).toMatch(/"2026-01-15","2026-02-14"/);
    });

    it("neutralises spreadsheet formulas in text cells", async () => {
      const body = (await get("financeA", "/exports/finance.csv")).body;

      expect(body).toContain(`"'=cmd|' /C calc'!A0"`);
      expect(body).not.toContain(`,"=cmd`);
      expect(body).not.toMatch(/^"=/m);
    });

    it("exports only the company's own invoices", async () => {
      const body = (await get("financeA", "/exports/finance.csv")).body;

      expect(body).toContain("A-PAID");
      expect(body).not.toContain("B-PAID");
    });

    it("is closed to roles without finance access", async () => {
      expect((await get("salesA", "/exports/finance.csv")).statusCode).toBe(403);
      expect((await get("hrA", "/exports/finance.csv")).statusCode).toBe(403);
    });
  });
});
