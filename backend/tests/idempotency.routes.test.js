/**
 * The offline outbox replays a mutation whenever the response is lost, always
 * with the same `Idempotency-Key`. That is half of the contract; this file is
 * the other half. If the *server* does not honour the key, a flaky connection
 * turns into two invoices for one piece of work, and nothing in the product
 * ever reports it: both requests answered 201.
 *
 * The routes, the schemas, the authentication plugin and the audit plugin are
 * the real ones. Only the database client is replaced -- by `FakeDatabase`,
 * which recognises exactly the statements the application issues and refuses
 * anything else, so a drifting query fails the suite instead of passing it.
 *
 * Every assertion here is about state, not timing: how many rows exist, how
 * many audit entries were written, and which bytes were returned.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { auditPlugin } from "../src/plugins/audit.js";
import { authenticationPlugin } from "../src/plugins/authentication.js";
import { signAccessToken } from "../src/modules/auth/routes.js";
import { resourceRoutes } from "../src/modules/resources/routes.js";
import { FakeDatabase } from "./helpers/fake-database.js";

const TENANT_A = "3f1d1a88-0a6a-4f2f-9e43-6f14f0a1b111";
const TENANT_B = "5c2e2b99-1b7b-4a3a-8f54-7a25e1b2c222";
const ACTOR = "a4b0c1d2-7e5f-4a3b-8c9d-0e1f2a3b4c5d";
const SESSION = "b7c8d9e0-1f2a-4b3c-8d9e-0f1a2b3c4d5e";
const KEY = "7b1f0c9e-3a6d-4f52-9c21-8d4e5f6a7b8c";

const client = { name: "Nadia Chraibi", company: "Sahara Textile SARL" };

let app;
let db;

/** A token signed by the API's own helper, so it is the one a login hands out. */
function tokenFor(tenantId) {
  return signAccessToken(app, { userId: ACTOR, tenantId, role: "owner", sessionId: SESSION });
}

function request({ method = "POST", url, payload, key, tenantId = TENANT_A }) {
  return app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: {
      authorization: `Bearer ${tokenFor(tenantId)}`,
      ...(key ? { "idempotency-key": key } : {}),
    },
  });
}

/**
 * Loading this module blocks the event loop long enough for
 * @fastify/under-pressure to answer 503 until its sampler next observes a free
 * loop. Poll until it has, rather than asserting against a stale measurement.
 * A bounded retry, not a sleep -- the same guard `rbac.routes.test.js` uses.
 */
async function settleUnderPressure() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const probe = await app.inject({ method: "GET", url: "/api/v1/clients" });
    if (probe.statusCode !== 503) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The application stayed under pressure; no request could be made");
}

const clientCount = () => db.rowsOf("clients").size;
const completions = () =>
  db.log.filter((sql) => sql.startsWith("UPDATE idempotency_keys SET response_status")).length;

beforeAll(async () => {
  app = await buildApp({ infrastructure: false, logger: false });
  db = new FakeDatabase();
  app.decorate("withTenant", (auth, operation) => db.transaction(auth, operation));
  app.decorate("withRuntimeRole", (operation) => db.transaction(null, operation));
  await auditPlugin(app);
  await authenticationPlugin(app, { config: app.config });
  await app.register(resourceRoutes, { prefix: "/api/v1" });
  await app.ready();
  await settleUnderPressure();
});

beforeEach(() => db.reset());

afterAll(async () => app?.close());

describe("a replayed create", () => {
  it("applies the mutation once and returns the first response again", async () => {
    const first = await request({ url: "/api/v1/clients", payload: client, key: KEY });
    const replay = await request({ url: "/api/v1/clients", payload: client, key: KEY });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    // Byte-identical: the caller cannot tell the replay apart, which is what
    // lets the outbox retry without reconciling anything.
    expect(replay.body).toBe(first.body);

    // The damage this prevents: two clients, two audit entries, one intent.
    expect(clientCount()).toBe(1);
    expect(db.audit).toHaveLength(1);
    expect(completions()).toBe(1);
  });

  it("refuses the key when the replayed body is not the one it was issued for", async () => {
    await request({ url: "/api/v1/clients", payload: client, key: KEY });
    const mismatch = await request({
      url: "/api/v1/clients",
      payload: { ...client, company: "A Different Company SARL" },
      key: KEY,
    });

    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    // Refused, not silently deduplicated: answering 201 with the first
    // response would tell the caller a mutation it never made had succeeded.
    expect(clientCount()).toBe(1);
  });

  it("refuses a key whose first request has not finished yet", async () => {
    await request({ url: "/api/v1/clients", payload: client, key: KEY });
    // The state a concurrent, still-running duplicate leaves behind: reserved,
    // no response recorded. Taken from the real reservation, so the stored
    // request hash is the one the application computed.
    db.idempotency.get(`${TENANT_A}|${KEY}`).response_status = null;

    const concurrent = await request({ url: "/api/v1/clients", payload: client, key: KEY });

    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json().error.code).toBe("REQUEST_IN_PROGRESS");
    expect(clientCount()).toBe(1);
  });

  it("rejects a malformed key before touching the database", async () => {
    const short = await request({ url: "/api/v1/clients", payload: client, key: "abc" });
    const spaced = await request({
      url: "/api/v1/clients",
      payload: client,
      key: "not a valid key",
    });
    const oversized = await request({
      url: "/api/v1/clients",
      payload: client,
      key: "k".repeat(121),
    });

    for (const response of [short, spaced, oversized]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    }
    // Nothing was written, and nothing was even read: the guard runs first.
    expect(db.log).toEqual([]);
    expect(clientCount()).toBe(0);
  });

  it("does not deduplicate requests that carry no key at all", async () => {
    await request({ url: "/api/v1/clients", payload: client });
    await request({ url: "/api/v1/clients", payload: client });

    // Deduplication is opt-in, by header. Two identical bodies are two
    // deliberate records, and the server must not guess otherwise.
    expect(clientCount()).toBe(2);
    expect(db.audit).toHaveLength(2);
  });

  it("scopes the key to one tenant, so a collision cannot leak a response", async () => {
    const forA = await request({ url: "/api/v1/clients", payload: client, key: KEY });
    const forB = await request({
      url: "/api/v1/clients",
      payload: client,
      key: KEY,
      tenantId: TENANT_B,
    });

    expect(forB.statusCode).toBe(201);
    // The second tenant gets its own record, not tenant A's cached body --
    // which would be a cross-tenant disclosure through the cache.
    expect(forB.json().data.id).not.toBe(forA.json().data.id);
    expect(forB.json().data.tenantId).toBe(TENANT_B);
    expect(clientCount()).toBe(2);
  });

  it("treats the key as new once its 24 hour window has passed", async () => {
    await request({ url: "/api/v1/clients", payload: client, key: KEY });
    db.advanceHours(25);
    const afterExpiry = await request({ url: "/api/v1/clients", payload: client, key: KEY });

    expect(afterExpiry.statusCode).toBe(201);
    expect(clientCount()).toBe(2);
    expect(db.log.some((sql) => sql.startsWith("DELETE FROM idempotency_keys"))).toBe(true);
  });
});

describe("a replayed update or delete", () => {
  async function seedClient() {
    const created = await request({ url: "/api/v1/clients", payload: client, key: KEY });
    db.reset();
    return db.seed("clients", { ...created.json().data, ...client, tenant_id: TENANT_A });
  }

  it("does not bump the version twice, and does not fabricate a conflict", async () => {
    const row = await seedClient();
    const patch = {
      method: "PATCH",
      url: `/api/v1/clients/${row.id}`,
      payload: { version: 1, name: "Nadia Chraibi-Bennani" },
      key: KEY,
    };

    const first = await request(patch);
    const replay = await request(patch);

    expect(first.statusCode).toBe(200);
    // Without the gate the replay would find version 2 and answer 409, so a
    // dropped response would surface to the user as "changed by another user".
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(db.rowsOf("clients").get(row.id).version).toBe(2);
    expect(db.audit.filter((entry) => entry.action === "client.updated")).toHaveLength(1);
  });

  it("answers a replayed delete with the same 204 and deletes once", async () => {
    const row = await seedClient();
    const remove = { method: "DELETE", url: `/api/v1/clients/${row.id}?version=1`, key: KEY };

    const first = await request(remove);
    const replay = await request(remove);

    expect(first.statusCode).toBe(204);
    expect(replay.statusCode).toBe(204);
    expect(replay.body).toBe("");
    expect(db.audit.filter((entry) => entry.action === "client.deleted")).toHaveLength(1);
    expect(db.rowsOf("clients").get(row.id).version).toBe(2);
  });
});

describe("a mutation that fails", () => {
  it("leaves the key free instead of caching the failure", async () => {
    const existing = db.seed("clients", { id: SESSION, tenant_id: TENANT_A, ...client });

    const response = await request({
      url: "/api/v1/clients",
      payload: { id: existing.id, ...client },
      key: KEY,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DUPLICATE_RECORD");
    // No response was recorded against the key, and the reservation rolled
    // back with the transaction -- a poisoned key would make every later retry
    // replay a failure the caller could never clear.
    expect(completions()).toBe(0);
    expect(db.idempotency.size).toBe(0);
  });
});
