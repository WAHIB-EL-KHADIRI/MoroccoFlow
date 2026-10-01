/**
 * Quote -> accepted -> project + payment obligation -> payments, end to end through
 * the real routes, the real permission guards and a real PostgreSQL with RLS.
 * Only Redis, S3 and the login flow are left out; tokens are signed by the API's own
 * helper. Assertions about what exists read the database directly as the superuser,
 * so they cannot be fooled by the same RLS context that produced the data.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { authenticationPlugin } from "../src/plugins/authentication.js";
import { auditPlugin } from "../src/plugins/audit.js";
import { databasePlugin } from "../src/plugins/database.js";
import { signAccessToken } from "../src/modules/auth/routes.js";
import { resourceRoutes } from "../src/modules/resources/routes.js";
import { quoteRoutes } from "../src/modules/quotes/routes.js";
import { paymentRoutes } from "../src/modules/payments/routes.js";
import { acceptQuote } from "../src/modules/quotes/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("quote to payment flow on PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const users = {
    ownerA: randomUUID(),
    salesA: randomUUID(),
    financeA: randomUUID(),
    pmA: randomUUID(),
    ownerB: randomUUID(),
  };
  const clientA = randomUUID();
  const clientB = randomUUID();
  let app;
  let seq = 0;

  const tokens = {};
  const as = (who) => ({ authorization: `Bearer ${tokens[who]}` });
  const api = (who, method, url, payload, headers = {}) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { ...as(who), ...headers }, payload });
  const count = async (sql, values) => Number((await pool.query(sql, values)).rows[0].count);
  const businessDay = async (offset) =>
    (
      await pool.query(
        "SELECT ((now() AT TIME ZONE 'Africa/Casablanca')::date + $1::int)::text AS day",
        [offset],
      )
    ).rows[0].day;

  async function createQuote(who = "salesA", overrides = {}) {
    seq += 1;
    const response = await api(who, "POST", "/quotes", {
      clientId: clientA,
      number: `DV-T-${tenantA.slice(0, 6)}-${seq}`,
      issueDate: "2026-09-01",
      subtotalCents: 1_666_667,
      taxCents: 333_333,
      currency: "MAD",
      status: "sent",
      ...overrides,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().data;
  }

  const accept = (who, quoteId, body = { dueDate: "2026-12-31" }, headers) =>
    api(who, "POST", `/quotes/${quoteId}/accept`, body, headers);

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [tenantA, `qa-${tenantA.slice(0, 8)}`, tenantB, `qb-${tenantB.slice(0, 8)}`],
    );
    const roles = { ownerA: "owner", salesA: "sales", financeA: "finance", pmA: "project_manager" };
    for (const [key, role] of Object.entries(roles)) {
      await pool.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'x', $4, $5)`,
        [users[key], tenantA, `${key}-${users[key]}@example.test`, key, role],
      );
    }
    await pool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'x', 'ownerB', 'owner')`,
      [users.ownerB, tenantB, `ownerB-${users.ownerB}@example.test`],
    );
    await pool.query(
      `INSERT INTO clients (id, tenant_id, name, company) VALUES ($1, $2, 'Client A', 'A SARL'),
       ($3, $4, 'Client B', 'B SARL')`,
      [clientA, tenantA, clientB, tenantB],
    );

    app = await buildApp({ infrastructure: false, logger: false });
    await databasePlugin(app, { config: { ...app.config, databaseUrl } });
    await authenticationPlugin(app, { config: app.config });
    await auditPlugin(app);
    await app.register(resourceRoutes, { prefix: "/api/v1" });
    await app.register(quoteRoutes, { prefix: "/api/v1" });
    await app.register(paymentRoutes, { prefix: "/api/v1" });
    await app.ready();
    // Same bounded wait as the other route suites: under-pressure answers 503 until
    // its sampler first observes a free event loop after boot.
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const probe = await app.inject({ method: "GET", url: "/api/v1/quotes" });
      if (probe.statusCode !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const roleOf = { ...roles, ownerB: "owner" };
    for (const [key, role] of Object.entries(roleOf)) {
      const tenantId = key.endsWith("B") ? tenantB : tenantA;
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
        // Superuser cleanup of rows the runtime role may never delete.
        await pool.query("DELETE FROM payments WHERE tenant_id = $1", [tenant]);
        await pool.query("DELETE FROM payment_obligations WHERE tenant_id = $1", [tenant]);
        await pool.query("DELETE FROM projects WHERE tenant_id = $1", [tenant]);
        await pool.query("DELETE FROM audit_logs WHERE tenant_id = $1", [tenant]);
        await pool.query("DELETE FROM tenants WHERE id = $1", [tenant]);
      }
    } finally {
      await pool.end();
    }
  });

  describe("quotes", () => {
    it("answers 201 only once the row is committed and readable", async () => {
      // Regression: the CRUD layer used to reply from inside the transaction, so the
      // next request could arrive before COMMIT and get a 404 for a "created" row.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const quote = await createQuote();
        expect((await api("salesA", "GET", `/quotes/${quote.id}`)).statusCode).toBe(200);
      }
    });

    it("lets sales create, read and update an open quote", async () => {
      const quote = await createQuote("salesA", { status: "draft" });
      expect(quote.totalCents).toBe("2000000");

      const sent = await api("salesA", "PATCH", `/quotes/${quote.id}`, {
        version: quote.version,
        status: "sent",
        notes: "Relancé par téléphone",
      });
      expect(sent.statusCode).toBe(200);

      const detail = await api("salesA", "GET", `/quotes/${quote.id}`);
      expect(detail.statusCode).toBe(200);
      const body = detail.json().data;
      expect(body.status).toBe("sent");
      expect(body.effectiveStatus).toBe("sent");
      expect(body.history.map((entry) => entry.action)).toEqual(["quote.created", "quote.updated"]);
      // Sales sees the quote, never the balance.
      expect(body.obligation).toBeNull();
    });

    it("refuses an illegal transition and any direct write of 'accepted'", async () => {
      const quote = await createQuote("salesA", { status: "draft" });
      const direct = await api("salesA", "PATCH", `/quotes/${quote.id}`, {
        version: quote.version,
        status: "accepted",
      });
      expect(direct.statusCode).toBe(400);

      const rejected = await api("salesA", "PATCH", `/quotes/${quote.id}`, {
        version: quote.version,
        status: "rejected",
      });
      expect(rejected.json().error.code).toBe("INVALID_TRANSITION");
    });

    it("hides one company's quotes from another and refuses foreign clients", async () => {
      const quote = await createQuote();
      expect((await api("ownerB", "GET", `/quotes/${quote.id}`)).statusCode).toBe(404);
      const patch = await api("ownerB", "PATCH", `/quotes/${quote.id}`, {
        version: quote.version,
        notes: "x",
      });
      expect(patch.statusCode).toBe(404);
      const list = await api("ownerB", "GET", "/quotes?limit=100");
      expect(list.json().data.map((row) => row.id)).not.toContain(quote.id);

      const foreignClient = await api("ownerB", "POST", "/quotes", {
        clientId: clientA,
        number: `DV-B-${randomUUID().slice(0, 8)}`,
        issueDate: "2026-09-01",
      });
      expect(foreignClient.statusCode).toBe(400);
      expect(foreignClient.json().error.code).toBe("INVALID_RELATION");
    });
  });

  describe("accepting a quote", () => {
    it("accepts the quote and opens its project and payment obligation together", async () => {
      const quote = await createQuote();
      const response = await accept("salesA", quote.id, {
        dueDate: "2026-12-31",
        projectName: "Site vitrine",
      });
      expect(response.statusCode).toBe(201);
      const { quote: accepted, project, obligation, replayed } = response.json().data;
      expect(replayed).toBe(false);
      expect(accepted.status).toBe("accepted");
      expect(accepted.acceptedBy).toBe(users.salesA);
      expect(project).toMatchObject({ name: "Site vitrine", quoteId: quote.id, clientId: clientA });
      expect(obligation).toMatchObject({
        quoteId: quote.id,
        projectId: project.id,
        clientId: clientA,
        amountCents: "2000000",
      });
      const due = await pool.query(
        "SELECT due_date::text AS due FROM payment_obligations WHERE id = $1",
        [obligation.id],
      );
      expect(due.rows[0].due).toBe("2026-12-31");

      const actions = await pool.query(
        "SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_id = ANY($2) ORDER BY id",
        [tenantA, [quote.id, project.id, obligation.id]],
      );
      expect(actions.rows.map((row) => row.action)).toEqual([
        "quote.created",
        "quote.accepted",
        "project.created",
        "payment_obligation.created",
      ]);
    });

    it("returns the same project when the same quote is accepted again", async () => {
      const quote = await createQuote();
      const first = await accept("salesA", quote.id);
      const second = await accept("financeA", quote.id, { dueDate: "2027-06-30" });
      expect(second.statusCode).toBe(200);
      expect(second.json().data.replayed).toBe(true);
      expect(second.json().data.project.id).toBe(first.json().data.project.id);
      expect(await count("SELECT count(*) FROM projects WHERE quote_id = $1", [quote.id])).toBe(1);
      expect(
        await count("SELECT count(*) FROM payment_obligations WHERE quote_id = $1", [quote.id]),
      ).toBe(1);
    });

    it("creates one project when two acceptances race", async () => {
      const quote = await createQuote();
      const responses = await Promise.all([
        accept("salesA", quote.id),
        accept("ownerA", quote.id),
        accept("financeA", quote.id),
      ]);
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
      expect(await count("SELECT count(*) FROM projects WHERE quote_id = $1", [quote.id])).toBe(1);
      expect(
        await count("SELECT count(*) FROM payment_obligations WHERE quote_id = $1", [quote.id]),
      ).toBe(1);
    });

    it("replays the stored response for a repeated Idempotency-Key", async () => {
      const quote = await createQuote();
      const headers = { "idempotency-key": `accept-${quote.id}` };
      const first = await accept("salesA", quote.id, undefined, headers);
      const again = await accept("salesA", quote.id, undefined, headers);
      expect(again.statusCode).toBe(first.statusCode);
      expect(again.json()).toEqual(first.json());
    });

    it("rolls everything back when a later step fails", async () => {
      const quote = await createQuote();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE moroccoflow_app");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        // The obligation insert is the last write: failing it must undo the quote
        // update and the project insert that already succeeded before it.
        const sabotaged = {
          query: (sql, values) =>
            /INSERT INTO payment_obligations/.test(sql)
              ? Promise.reject(new Error("simulated failure"))
              : client.query(sql, values),
        };
        await expect(
          acceptQuote(
            sabotaged,
            { tenantId: tenantA, userId: users.salesA },
            { quoteId: quote.id, dueDate: "2026-12-31" },
            async () => {},
          ),
        ).rejects.toThrow("simulated failure");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      const stored = await pool.query("SELECT status FROM quotes WHERE id = $1", [quote.id]);
      expect(stored.rows[0].status).toBe("sent");
      expect(await count("SELECT count(*) FROM projects WHERE quote_id = $1", [quote.id])).toBe(0);
    });

    it("locks an accepted quote against edits and deletion", async () => {
      const quote = await createQuote();
      await accept("salesA", quote.id);
      const current = (await api("salesA", "GET", `/quotes/${quote.id}`)).json().data;
      const patch = await api("salesA", "PATCH", `/quotes/${quote.id}`, {
        version: current.version,
        notes: "trop tard",
      });
      expect(patch.json().error.code).toBe("QUOTE_LOCKED");
      const remove = await api("salesA", "DELETE", `/quotes/${quote.id}?version=${current.version}`);
      expect(remove.json().error.code).toBe("QUOTE_LOCKED");
    });

    it("refuses an expired, a rejected and an empty quote, and creates nothing", async () => {
      const expired = await createQuote("salesA", { validUntil: await businessDay(-1) });
      const detail = (await api("salesA", "GET", `/quotes/${expired.id}`)).json().data;
      expect(detail.effectiveStatus).toBe("expired");
      expect((await accept("salesA", expired.id)).json().error.code).toBe("QUOTE_EXPIRED");

      const rejected = await createQuote();
      await api("salesA", "PATCH", `/quotes/${rejected.id}`, {
        version: rejected.version,
        status: "rejected",
      });
      expect((await accept("salesA", rejected.id)).json().error.code).toBe(
        "QUOTE_NOT_ACCEPTABLE",
      );

      const empty = await createQuote("salesA", { subtotalCents: 0, taxCents: 0 });
      expect((await accept("salesA", empty.id)).statusCode).toBe(422);

      const ids = [expired.id, rejected.id, empty.id];
      expect(await count("SELECT count(*) FROM projects WHERE quote_id = ANY($1)", [ids])).toBe(0);
    });

    it("refuses another company and an unauthorised role", async () => {
      const quote = await createQuote();
      expect((await accept("ownerB", quote.id)).statusCode).toBe(404);
      expect((await accept("pmA", quote.id)).statusCode).toBe(403);
      expect(await count("SELECT count(*) FROM projects WHERE quote_id = $1", [quote.id])).toBe(0);
      const stored = await pool.query("SELECT status FROM quotes WHERE id = $1", [quote.id]);
      expect(stored.rows[0].status).toBe("sent");
    });
  });

  describe("payments", () => {
    async function acceptedObligation(dueDate = "2026-12-31") {
      const quote = await createQuote();
      const response = await accept("salesA", quote.id, { dueDate });
      return response.json().data.obligation.id;
    }
    const pay = (id, amountCents, who = "financeA") =>
      api(who, "POST", `/payment-obligations/${id}/payments`, {
        amountCents,
        paidOn: "2026-10-01",
        method: "transfer",
      });
    const read = async (id) => (await api("financeA", "GET", `/payment-obligations/${id}`)).json().data;

    it("tracks unpaid, partial and paid with exact centimes", async () => {
      const id = await acceptedObligation();
      expect(await read(id)).toMatchObject({
        paymentStatus: "unpaid",
        paidCents: "0",
        remainingCents: "2000000",
      });

      expect((await pay(id, 800_000)).statusCode).toBe(201);
      expect(await read(id)).toMatchObject({
        paymentStatus: "partial",
        paidCents: "800000",
        remainingCents: "1200000",
      });

      expect((await pay(id, 1_200_000)).statusCode).toBe(201);
      const settled = await read(id);
      expect(settled).toMatchObject({ paymentStatus: "paid", remainingCents: "0" });
      expect(settled.payments).toHaveLength(2);
    });

    it("refuses to take more than is owed", async () => {
      const id = await acceptedObligation();
      const response = await pay(id, 2_000_001);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({
        code: "OVERPAYMENT",
        details: { remainingCents: 2_000_000 },
      });
      expect(await count("SELECT count(*) FROM payments WHERE obligation_id = $1", [id])).toBe(0);
    });

    it("derives overdue from the business date, never from input", async () => {
      const late = await acceptedObligation(await businessDay(-1));
      expect((await read(late)).paymentStatus).toBe("overdue");
      await pay(late, 500_000);
      expect((await read(late)).paymentStatus).toBe("overdue");

      const dueToday = await acceptedObligation(await businessDay(0));
      expect((await read(dueToday)).paymentStatus).toBe("unpaid");

      const listed = await api("financeA", "GET", "/payment-obligations?status=overdue&limit=100");
      expect(listed.json().data.map((row) => row.id)).toContain(late);
      expect(listed.json().data.map((row) => row.id)).not.toContain(dueToday);
    });

    it("keeps balances away from sales and from other companies", async () => {
      const id = await acceptedObligation();
      expect((await api("salesA", "GET", "/payment-obligations")).statusCode).toBe(403);
      expect((await pay(id, 100, "salesA")).statusCode).toBe(403);
      expect((await api("ownerB", "GET", `/payment-obligations/${id}`)).statusCode).toBe(404);
      expect((await pay(id, 100, "ownerB")).statusCode).toBe(404);
      const listB = await api("ownerB", "GET", "/payment-obligations?limit=100");
      expect(listB.json().data).toEqual([]);
    });

    it("keeps the payment ledger append-only for the runtime role", async () => {
      const id = await acceptedObligation();
      await pay(id, 100);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE moroccoflow_app");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        await expect(
          client.query("UPDATE payments SET amount_cents = 1 WHERE obligation_id = $1", [id]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("records who did what through the shared audit helper", async () => {
      const id = await acceptedObligation();
      await pay(id, 100);
      const rows = await pool.query(
        "SELECT action, actor_user_id FROM audit_logs WHERE entity_id = $1 ORDER BY id",
        [id],
      );
      expect(rows.rows).toEqual([
        { action: "payment_obligation.created", actor_user_id: users.salesA },
        { action: "payment.recorded", actor_user_id: users.financeA },
      ]);
    });
  });
});
