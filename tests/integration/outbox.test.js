/**
 * The offline outbox is the part of this product most likely to corrupt data
 * without anyone noticing. The happy path is trivial; the dangerous path is a
 * flaky connection, where a mutation is sent, the response is lost, and the
 * client sends it again. If the replay does not carry the *same*
 * Idempotency-Key and the *same* body, the server cannot recognise it, and the
 * user ends up with two invoices for one piece of work.
 *
 * These tests drive the real store and the real API client, with `fetch`
 * replaced by a recording transport, and assert on the bytes that would go
 * over the wire.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const API_BASE = "http://api.test/api/v1";

let appStore;
let database;
/** Every request the client attempted, in order. */
let calls;
/** Set to make the next POST/PATCH/DELETE fail the way a dropped connection does. */
let failMutations;

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function transport(url, options = {}) {
  const method = options.method || "GET";
  const path = url.replace(API_BASE, "");
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  calls.push({ method, path, headers, body: options.body });

  if (method !== "GET" && !path.startsWith("/auth/")) {
    if (failMutations) return Promise.reject(new TypeError("Failed to fetch"));
    if (method === "DELETE") return Promise.resolve(jsonResponse(204, null));
    return Promise.resolve(jsonResponse(201, { data: { id: "server-id", version: 1 } }));
  }
  if (path.startsWith("/auth/me")) {
    return Promise.resolve(
      jsonResponse(200, {
        data: { tenantName: "Riad Noor", tenantSlug: "riad-noor", role: "owner" },
      }),
    );
  }
  if (path.startsWith("/auth/")) {
    return Promise.resolve(jsonResponse(200, { data: { accessToken: "test-access-token" } }));
  }
  return Promise.resolve(jsonResponse(200, { data: [], page: { hasMore: false } }));
}

const mutations = () => calls.filter((call) => call.method !== "GET");

beforeAll(async () => {
  // apiEnabled is decided at module load from the build-time base URL, so the
  // modules have to be loaded after the variable is in place.
  vi.stubEnv("VITE_API_BASE_URL", API_BASE);
  vi.resetModules();
  appStore = (await import("../../src/core/store.js")).appStore;
  database = await import("../../src/core/database.js");
  expect((await import("../../src/core/api.js")).apiEnabled).toBe(true);
});

beforeEach(async () => {
  calls = [];
  failMutations = false;
  vi.stubGlobal("fetch", vi.fn(transport));
  await database.clearDatabase();
  await appStore.reload();
});

afterEach(() => vi.unstubAllGlobals());

describe("a mutation that fails in flight", () => {
  it("is retried with the identical key and body, and only then dropped", async () => {
    failMutations = true;
    await appStore.save("invoices", {
      clientId: "c1",
      number: "FA-2026-901",
      amount: 125_000,
      status: "pending",
      date: "2026-03-01T00:00:00.000Z",
      dueDate: "2026-03-31T00:00:00.000Z",
    });

    // The connection dropped: the mutation must still be queued. Losing it here
    // is silent data loss -- the user saw "saved".
    const queued = await database.pendingMutations();
    expect(queued).toHaveLength(1);
    expect(appStore.state.syncError).toBeTruthy();

    failMutations = false;
    await appStore.sync();

    const attempts = mutations();
    expect(attempts).toHaveLength(2);
    expect(attempts[0].path).toBe("/invoices");
    expect(attempts[1].path).toBe("/invoices");

    // The two properties the server's idempotency gate depends on: the key
    // identifies the mutation, and the body hash must match it. A body that
    // differed on retry would be refused with a 409 instead of deduplicated.
    expect(attempts[0].headers["idempotency-key"]).toBe(queued[0].mutationId);
    expect(attempts[1].headers["idempotency-key"]).toBe(attempts[0].headers["idempotency-key"]);
    expect(attempts[1].body).toBe(attempts[0].body);

    expect(await database.pendingMutations()).toHaveLength(0);
  });

  it("sends money as integer centimes in the body it replays", async () => {
    failMutations = true;
    await appStore.save("invoices", {
      clientId: "c1",
      number: "FA-2026-902",
      amount: 125_055,
      status: "paid",
      date: "2026-03-01T00:00:00.000Z",
      dueDate: "2026-03-31T00:00:00.000Z",
    });
    failMutations = false;
    await appStore.sync();

    for (const attempt of mutations()) {
      const body = JSON.parse(attempt.body);
      expect(body.subtotalCents).toBe(125_055);
      expect(Number.isInteger(body.subtotalCents)).toBe(true);
      // Marked paid, so the payment recorded must match the invoice exactly:
      // the API rejects paid_cents above the total.
      expect(body.paidCents).toBe(125_055);
      expect(body.currency).toBe("MAD");
    }
  });

  it("keeps one key per mutation, not one per attempt", async () => {
    failMutations = true;
    await appStore.save("clients", {
      name: "Nadia Chraibi",
      company: "Sahara Textile",
      email: "nadia@sahara.demo",
      phone: "+212661112233",
    });
    await appStore.sync();
    await appStore.sync();

    const keys = new Set(mutations().map((call) => call.headers["idempotency-key"]));
    expect(mutations().length).toBeGreaterThanOrEqual(3);
    expect(keys.size).toBe(1);
  });
});

describe("queued mutations", () => {
  it("replays in the order they were made, each with its own key", async () => {
    failMutations = true;
    for (const number of ["FA-2026-910", "FA-2026-911", "FA-2026-912"]) {
      await appStore.save("invoices", {
        clientId: "c1",
        number,
        amount: 1000,
        status: "draft",
        date: "2026-03-01T00:00:00.000Z",
        dueDate: "2026-03-31T00:00:00.000Z",
      });
    }
    expect(await database.pendingMutations()).toHaveLength(3);

    calls = [];
    failMutations = false;
    await appStore.sync();

    const sent = mutations().map((call) => JSON.parse(call.body).number);
    expect(sent).toEqual(["FA-2026-910", "FA-2026-911", "FA-2026-912"]);
    expect(new Set(mutations().map((call) => call.headers["idempotency-key"])).size).toBe(3);
    expect(await database.pendingMutations()).toHaveLength(0);
  });

  it("stops at the first failure so a replay cannot reorder the queue", async () => {
    failMutations = true;
    await appStore.save("clients", {
      name: "Amine Tazi",
      company: "Tazi Logistique",
      email: "amine@tazi.demo",
      phone: "+212662223344",
    });
    await appStore.save("clients", {
      name: "Hind Berrada",
      company: "Berrada Conseil",
      email: "hind@berrada.demo",
      phone: "+212663334455",
    });

    // One attempt, not two: the second mutation must not overtake the first.
    expect(mutations()).toHaveLength(2);
    expect(await database.pendingMutations()).toHaveLength(2);
  });

  it("carries the key and the optimistic-locking version on a delete", async () => {
    await database.put("clients", {
      id: "client-to-delete",
      name: "Obsolete",
      company: "Obsolete SARL",
      version: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await appStore.reload();
    calls = [];

    await appStore.delete("clients", "client-to-delete");

    const [deletion] = mutations();
    expect(deletion.method).toBe("DELETE");
    expect(deletion.path).toBe("/clients/client-to-delete?version=4");
    expect(deletion.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await database.pendingMutations()).toHaveLength(0);
  });
});
