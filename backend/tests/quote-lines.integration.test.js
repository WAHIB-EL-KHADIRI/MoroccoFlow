/**
 * Quote lines and VAT through the real route, real permission guards and a real
 * PostgreSQL with RLS. Same harness as the quote-to-payment flow: tokens are signed by
 * the API's own helper, and assertions about stored data read the database directly as
 * the superuser so they cannot be fooled by the RLS context that produced it.
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

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("quote lines and VAT on PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const users = { salesA: randomUUID(), viewerA: randomUUID(), ownerB: randomUUID() };
  const clientA = randomUUID();
  let app;
  let seq = 0;

  const tokens = {};
  const api = (who, method, url, payload) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${tokens[who]}` },
      payload,
    });

  async function createQuote(status = "draft") {
    seq += 1;
    const response = await api("salesA", "POST", "/quotes", {
      clientId: clientA,
      number: `DV-L-${tenantA.slice(0, 6)}-${seq}`,
      issueDate: "2026-09-01",
      status,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().data;
  }

  const putLines = (who, quoteId, lines) => api(who, "PUT", `/quotes/${quoteId}/lines`, { lines });
  const storedLines = async (quoteId) =>
    (await pool.query("SELECT * FROM line_items WHERE quote_id = $1 ORDER BY position", [quoteId]))
      .rows;
  const storedQuote = async (quoteId) =>
    (await pool.query("SELECT * FROM quotes WHERE id = $1", [quoteId])).rows[0];

  beforeAll(async () => {
    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      tenantA,
      `la-${tenantA.slice(0, 8)}`,
      tenantB,
      `lb-${tenantB.slice(0, 8)}`,
    ]);
    const roles = [
      ["salesA", tenantA, "sales"],
      ["viewerA", tenantA, "viewer"],
      ["ownerB", tenantB, "owner"],
    ];
    for (const [key, tenantId, role] of roles) {
      await pool.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'x', $4, $5)`,
        [users[key], tenantId, `${key}-${users[key]}@example.test`, key, role],
      );
    }
    await pool.query(
      `INSERT INTO clients (id, tenant_id, name, company) VALUES ($1, $2, 'Client A', 'A SARL')`,
      [clientA, tenantA],
    );

    app = await buildApp({ infrastructure: false, logger: false });
    await databasePlugin(app, { config: { ...app.config, databaseUrl } });
    await authenticationPlugin(app, { config: app.config });
    await auditPlugin(app);
    await app.register(resourceRoutes, { prefix: "/api/v1" });
    await app.register(quoteRoutes, { prefix: "/api/v1" });
    await app.ready();
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const probe = await app.inject({ method: "GET", url: "/api/v1/quotes" });
      if (probe.statusCode !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const roleOf = { salesA: "sales", viewerA: "viewer", ownerB: "owner" };
    for (const [key, role] of Object.entries(roleOf)) {
      tokens[key] = signAccessToken(app, {
        userId: users[key],
        tenantId: key.endsWith("B") ? tenantB : tenantA,
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

  it("stores the lines and computes subtotal, VAT and total from them", async () => {
    const quote = await createQuote();

    const response = await putLines("salesA", quote.id, [
      { description: "Site web", quantity: "1", unitPriceCents: 1_000_000, taxRateBasisPoints: 2000 },
      { description: "Formation", quantity: "2.5", unitPriceCents: 40_000, taxRateBasisPoints: 1000 },
    ]);

    expect(response.statusCode, response.body).toBe(200);
    const stored = await storedQuote(quote.id);
    expect(Number(stored.subtotal_cents)).toBe(1_100_000);
    expect(Number(stored.tax_cents)).toBe(210_000); // 20% of 1 000 000 + 10% of 100 000
    expect(Number(stored.total_cents)).toBe(1_310_000);
    expect(Number(stored.version)).toBe(2);
    expect(response.json().data.vat).toEqual([
      { rateBasisPoints: 1000, baseCents: 100_000, taxCents: 10_000 },
      { rateBasisPoints: 2000, baseCents: 1_000_000, taxCents: 200_000 },
    ]);
    expect((await storedLines(quote.id)).map((l) => l.description)).toEqual(["Site web", "Formation"]);
  });

  it("replaces previous lines instead of appending", async () => {
    const quote = await createQuote();
    await putLines("salesA", quote.id, [{ description: "Old", quantity: "1", unitPriceCents: 500 }]);

    const response = await putLines("salesA", quote.id, [
      { description: "New", quantity: "2", unitPriceCents: 250 },
    ]);

    expect(response.statusCode, response.body).toBe(200);
    const lines = await storedLines(quote.id);
    expect(lines.map((l) => l.description)).toEqual(["New"]);
    expect(Number((await storedQuote(quote.id)).subtotal_cents)).toBe(500);
  });

  it("an empty list clears the lines and zeroes the totals", async () => {
    const quote = await createQuote();
    await putLines("salesA", quote.id, [{ description: "X", quantity: "1", unitPriceCents: 900 }]);

    const response = await putLines("salesA", quote.id, []);

    expect(response.statusCode, response.body).toBe(200);
    expect(await storedLines(quote.id)).toHaveLength(0);
    const stored = await storedQuote(quote.id);
    expect([Number(stored.subtotal_cents), Number(stored.tax_cents)]).toEqual([0, 0]);
  });

  it("returns the lines in the quote detail", async () => {
    const quote = await createQuote();
    await putLines("salesA", quote.id, [
      { description: "B", quantity: "1", unitPriceCents: 100 },
      { description: "A", quantity: "3", unitPriceCents: 200, taxRateBasisPoints: 1400 },
    ]);

    const detail = await api("salesA", "GET", `/quotes/${quote.id}`);

    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.lines.map((l) => l.description)).toEqual(["B", "A"]);
  });

  it("refuses to change the lines of a quote that is no longer a draft", async () => {
    const quote = await createQuote("sent");

    const response = await putLines("salesA", quote.id, [
      { description: "X", quantity: "1", unitPriceCents: 100 },
    ]);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("QUOTE_NOT_DRAFT");
    expect(await storedLines(quote.id)).toHaveLength(0);
  });

  it("rejects a VAT rate that is not a Moroccan rate", async () => {
    const quote = await createQuote();

    const response = await putLines("salesA", quote.id, [
      { description: "X", quantity: "1", unitPriceCents: 100, taxRateBasisPoints: 1900 },
    ]);

    expect(response.statusCode).toBe(400);
    expect(await storedLines(quote.id)).toHaveLength(0);
  });

  it("rolls everything back when one line is invalid", async () => {
    const quote = await createQuote();
    await putLines("salesA", quote.id, [{ description: "Keep", quantity: "1", unitPriceCents: 700 }]);

    const response = await putLines("salesA", quote.id, [
      { description: "Fine", quantity: "1", unitPriceCents: 100 },
      { description: "Zero quantity", quantity: "0", unitPriceCents: 100 },
    ]);

    expect(response.statusCode).toBe(422);
    expect((await storedLines(quote.id)).map((l) => l.description)).toEqual(["Keep"]);
    expect(Number((await storedQuote(quote.id)).subtotal_cents)).toBe(700);
  });

  it("does not let a read-only role change lines", async () => {
    const quote = await createQuote();

    const response = await putLines("viewerA", quote.id, [
      { description: "X", quantity: "1", unitPriceCents: 100 },
    ]);

    expect(response.statusCode).toBe(403);
    expect(await storedLines(quote.id)).toHaveLength(0);
  });

  it("does not let another company touch the quote", async () => {
    const quote = await createQuote();

    const response = await putLines("ownerB", quote.id, [
      { description: "X", quantity: "1", unitPriceCents: 100 },
    ]);

    expect(response.statusCode).toBe(404);
    expect(await storedLines(quote.id)).toHaveLength(0);
  });

  it("answers 404 for a quote that does not exist", async () => {
    const response = await putLines("salesA", randomUUID(), []);

    expect(response.statusCode).toBe(404);
  });

  it("refuses a hand-written subtotal or tax once the quote has lines", async () => {
    const quote = await createQuote();
    await putLines("salesA", quote.id, [{ description: "X", quantity: "1", unitPriceCents: 1000 }]);
    const version = (await storedQuote(quote.id)).version;

    for (const patch of [{ subtotalCents: 1 }, { taxCents: 999_999 }]) {
      const response = await api("salesA", "PATCH", `/quotes/${quote.id}`, { version, ...patch });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("TOTALS_FROM_LINES");
    }
    const stored = await storedQuote(quote.id);
    expect([Number(stored.subtotal_cents), Number(stored.tax_cents)]).toEqual([1000, 0]);
  });

  it("still lets other fields change on a quote that has lines", async () => {
    const quote = await createQuote();
    await putLines("salesA", quote.id, [{ description: "X", quantity: "1", unitPriceCents: 1000 }]);
    const version = (await storedQuote(quote.id)).version;

    const response = await api("salesA", "PATCH", `/quotes/${quote.id}`, { version, notes: "ok" });

    expect(response.statusCode, response.body).toBe(200);
  });

  it("still allows manual totals on a quote without lines", async () => {
    const quote = await createQuote();

    const response = await api("salesA", "PATCH", `/quotes/${quote.id}`, {
      version: quote.version,
      subtotalCents: 5000,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(Number((await storedQuote(quote.id)).subtotal_cents)).toBe(5000);
  });

  it("writes an audit entry with the new totals", async () => {
    const quote = await createQuote();
    await putLines("salesA", quote.id, [
      { description: "X", quantity: "1", unitPriceCents: 1000, taxRateBasisPoints: 2000 },
    ]);

    const audit = await pool.query(
      "SELECT after_data FROM audit_logs WHERE entity_id = $1 AND action = 'quote.lines_replaced'",
      [quote.id],
    );

    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].after_data).toEqual({ lineCount: 1, subtotalCents: 1000, taxCents: 200 });
  });
});
