/**
 * The browser-side API client against a stubbed fetch: authentication and token refresh,
 * error mapping, workspace pull, and how local mutations become API calls. The server is
 * the authority; this pins what the client sends and how it reacts to what comes back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE = "https://api.example.test/api/v1";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function load(base = `${BASE}/`) {
  vi.resetModules();
  vi.stubEnv("VITE_API_BASE_URL", base);
  return import("../../src/core/api.js");
}

/** Installs a fetch stub driven by `handler(url, init) => Response | Promise<Response>`. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const path = String(url).replace(BASE, "");
    const call = { path, method: init.method || "GET", init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  });
  return calls;
}
const authOf = (call) => new Headers(call.init.headers).get("authorization");
const headerOf = (call, name) => new Headers(call.init.headers).get(name);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("is disabled without a base URL and enabled with one", async () => {
    expect((await load("")).apiEnabled).toBe(false);
    expect((await load("   ")).apiEnabled).toBe(false);
    expect((await load()).apiEnabled).toBe(true);
  });

  it("strips the trailing slash when building URLs", async () => {
    const { quotesApi } = await load(`${BASE}/`);
    const calls = stubFetch(() => json({ data: { id: "q1" } }));

    await quotesApi.get("q1");

    expect(calls[0].path).toBe("/quotes/q1");
  });
});

describe("login and requests", () => {
  it("posts credentials with cookies, drops an empty MFA code and then sends the bearer token", async () => {
    const { apiClient, quotesApi } = await load();
    const calls = stubFetch((call) =>
      call.path === "/auth/login" ? json({ data: { accessToken: "t1" } }) : json({ data: [] }),
    );

    await apiClient.login({ workspace: "acme", email: "a@b.test", password: "x", mfaCode: "" });
    await quotesApi.list();

    expect(calls[0].body).toEqual({ workspace: "acme", email: "a@b.test", password: "x" });
    expect(calls[0].init.credentials).toBe("include");
    expect(authOf(calls[0])).toBeNull();
    expect(authOf(calls[1])).toBe("Bearer t1");
  });

  it("keeps a supplied MFA code", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ data: { accessToken: "t1" } }));

    await apiClient.login({ workspace: "acme", email: "a@b.test", password: "x", mfaCode: "123456" });

    expect(calls[0].body.mfaCode).toBe("123456");
  });

  it("maps an unreachable server to a NETWORK_ERROR", async () => {
    const { quotesApi } = await load();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(quotesApi.get("x")).rejects.toMatchObject({ name: "ApiError", status: 0, code: "NETWORK_ERROR" });
  });

  it("maps API errors to ApiError with code, message and details", async () => {
    const { quotesApi } = await load();
    stubFetch(() => json({ error: { code: "QUOTE_LOCKED", message: "Locked", details: { a: 1 } } }, 409));

    await expect(quotesApi.update("q", {})).rejects.toMatchObject({
      status: 409,
      code: "QUOTE_LOCKED",
      message: "Locked",
      details: { a: 1 },
    });
  });

  it("falls back to a generic message when the error body is empty", async () => {
    const { quotesApi } = await load();
    stubFetch(() => new Response("oops", { status: 500, headers: { "content-type": "text/plain" } }));

    await expect(quotesApi.get("q")).rejects.toMatchObject({ status: 500, message: "API request failed" });
  });

  it("returns null for 204 and the inner data of a normal envelope", async () => {
    const { apiClient, quotesApi } = await load();
    stubFetch((call) => (call.path === "/auth/logout" ? new Response(null, { status: 204 }) : json({ data: { id: 1 } })));

    expect(await apiClient.logout()).toBeUndefined();
    expect(await quotesApi.get("q")).toEqual({ id: 1 });
  });
});

describe("token refresh", () => {
  async function loggedIn() {
    const mod = await load();
    let refreshes = 0;
    const calls = stubFetch(async (call) => {
      if (call.path === "/auth/login") return json({ data: { accessToken: "t1" } });
      if (call.path === "/auth/refresh") {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json({ data: { accessToken: "t2" } });
      }
      return authOf(call) === "Bearer t2" ? json({ data: { ok: call.path } }) : json({ error: { code: "UNAUTHORIZED" } }, 401);
    });
    await mod.apiClient.login({ workspace: "acme", email: "a@b.test", password: "x" });
    return { ...mod, calls, refreshCount: () => refreshes };
  }

  it("refreshes once on a 401 and retries with the new token", async () => {
    const { quotesApi, calls, refreshCount } = await loggedIn();

    expect(await quotesApi.get("a")).toEqual({ ok: "/quotes/a" });

    expect(refreshCount()).toBe(1);
    expect(calls.map((c) => c.path)).toEqual(["/auth/login", "/quotes/a", "/auth/refresh", "/quotes/a"]);
    expect(authOf(calls.at(-1))).toBe("Bearer t2");
  });

  it("shares ONE refresh between simultaneous 401s", async () => {
    // Refresh tokens rotate and a reused one is rejected, so a second concurrent
    // /auth/refresh would sign the user out. pullWorkspace fires 8 requests at once.
    const { quotesApi, refreshCount } = await loggedIn();

    const results = await Promise.all(["a", "b", "c", "d"].map((id) => quotesApi.get(id)));

    expect(results.map((r) => r.ok)).toEqual(["/quotes/a", "/quotes/b", "/quotes/c", "/quotes/d"]);
    expect(refreshCount()).toBe(1);
  });

  it("can refresh again later, because the shared promise is released", async () => {
    const { apiClient, refreshCount } = await loggedIn();

    await apiClient.refresh();
    await apiClient.refresh();

    expect(refreshCount()).toBe(2);
  });

  it("gives up with AuthRequiredError when the retry is still 401", async () => {
    const { quotesApi } = await load();
    const calls = stubFetch((call) =>
      call.path === "/auth/refresh" ? json({ data: { accessToken: "t2" } }) : json({ error: {} }, 401),
    );

    await expect(quotesApi.get("a")).rejects.toMatchObject({ name: "AuthRequiredError", status: 401 });
    expect(calls.filter((c) => c.path === "/auth/refresh")).toHaveLength(1);
  });

  it("surfaces AuthRequiredError when the refresh itself is refused", async () => {
    const { quotesApi } = await load();
    stubFetch(() => json({ error: { code: "UNAUTHORIZED" } }, 401));

    await expect(quotesApi.get("a")).rejects.toMatchObject({ name: "AuthRequiredError" });
  });

  it("never tries to refresh when an /auth/ call itself returns 401", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ error: { code: "INVALID_CREDENTIALS" } }, 401));

    await expect(apiClient.login({ workspace: "w", email: "e@e.test", password: "bad" })).rejects.toMatchObject({
      name: "AuthRequiredError",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("logout", () => {
  it("forgets the access token even if the server call fails", async () => {
    const { apiClient, quotesApi } = await load();
    let failLogout = false;
    const calls = stubFetch((call) => {
      if (call.path === "/auth/login") return json({ data: { accessToken: "t1" } });
      if (call.path === "/auth/logout" && failLogout) throw new TypeError("offline");
      return json({ data: [] });
    });
    await apiClient.login({ workspace: "w", email: "e@e.test", password: "x" });
    failLogout = true;

    await expect(apiClient.logout()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await quotesApi.list();

    expect(authOf(calls.at(-1))).toBeNull();
  });
});

describe("pullWorkspace", () => {
  const me = { id: "u1", tenantName: "Acme SARL", tenantSlug: "acme" };

  function server({ forbidden = [], pages = {} } = {}) {
    return stubFetch((call) => {
      const [path, query = ""] = call.path.split("?");
      if (path === "/auth/me") return json({ data: me });
      if (forbidden.includes(path)) return json({ error: { code: "FORBIDDEN" } }, 403);
      if (pages[path]) {
        const cursor = new URLSearchParams(query).get("cursor") || "first";
        return json(pages[path][cursor]);
      }
      if (path === "/team") return json({ data: [{ id: "e1", fullName: "Amina", role: "project_manager" }] });
      if (path === "/notifications") return json({ data: [{ id: "n1", readAt: "2026-01-01" }, { id: "n2", readAt: null }] });
      if (path === "/deals") return json({ data: [{ id: "d1", amountCents: "5000" }], page: { hasMore: false } });
      if (path === "/invoices") {
        return json({ data: [{ id: "i1", issueDate: "2026-02-03", totalCents: 12000 }], page: { hasMore: false } });
      }
      if (path === "/expenses") {
        return json({ data: [{ id: "x1", expenseDate: "2026-03-04", amountCents: 300 }], page: { hasMore: false } });
      }
      if (path === "/tasks") return json({ data: [{ id: "t1", assigneeUserId: "u9" }], page: { hasMore: false } });
      return json({ data: [], page: { hasMore: false } });
    });
  }

  it("adapts every collection to the shape the screens use", async () => {
    const { apiClient } = await load();
    server();

    const { data, user } = await apiClient.pullWorkspace();

    expect(user).toEqual(me);
    expect(data.deals[0].amount).toBe(5000);
    expect(data.invoices[0]).toMatchObject({ date: "2026-02-03", amount: 12000 });
    expect(data.expenses[0]).toMatchObject({ date: "2026-03-04", amount: 300 });
    expect(data.tasks[0].assignee).toBe("u9");
    expect(data.employees[0]).toMatchObject({ name: "Amina", role: "project manager" });
    expect(data.notifications.map((n) => n.read)).toEqual([true, false]);
    expect(data.settings).toEqual([{ id: "company", name: "Acme SARL", workspace: "acme", currency: "MAD" }]);
  });

  it("follows cursors until the last page", async () => {
    const { apiClient } = await load();
    const calls = server({
      pages: {
        "/clients": {
          first: { data: [{ id: "c1" }], page: { hasMore: true, nextCursor: "p2" } },
          p2: { data: [{ id: "c2" }], page: { hasMore: true, nextCursor: "p3" } },
          p3: { data: [{ id: "c3" }], page: { hasMore: false } },
        },
      },
    });

    const { data } = await apiClient.pullWorkspace();

    expect(data.clients.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(calls.filter((c) => c.path.startsWith("/clients"))).toHaveLength(3);
  });

  it("treats a 403 on an optional collection as empty, not as a failure", async () => {
    const { apiClient } = await load();
    server({ forbidden: ["/invoices", "/expenses", "/team"] });

    const { data } = await apiClient.pullWorkspace();

    expect([data.invoices, data.expenses, data.employees]).toEqual([[], [], []]);
    expect(data.deals).toHaveLength(1);
  });

  it("still fails on other errors", async () => {
    const { apiClient } = await load();
    stubFetch((call) => (call.path === "/auth/me" ? json({ data: me }) : json({ error: { code: "BOOM" } }, 500)));

    await expect(apiClient.pullWorkspace()).rejects.toMatchObject({ status: 500 });
  });
});

describe("pushMutation", () => {
  const mutation = (storeName, action, entity, mutationId = "m-1") => ({ storeName, action, entity, mutationId });

  it("creates with the client id, an idempotency key and only writable fields", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ data: {} }));

    await apiClient.pushMutation(
      mutation("clients", "save", { id: "c1", name: "Atlas", company: "Atlas SARL", secret: "no", version: undefined }),
    );

    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/clients");
    expect(headerOf(calls[0], "idempotency-key")).toBe("m-1");
    expect(calls[0].body).toEqual({ id: "c1", name: "Atlas", company: "Atlas SARL" });
  });

  it("updates with PATCH and the optimistic-locking version, without re-sending the id", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ data: {} }));

    await apiClient.pushMutation(mutation("projects", "save", { id: "p1", name: "Site", version: 3 }));

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].path).toBe("/projects/p1");
    expect(calls[0].body).toEqual({ name: "Site", version: 3 });
  });

  it("deletes with the version in the query string", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await apiClient.pushMutation(mutation("tasks", "delete", { id: "t1", version: 7 }, "m-9"));

    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/tasks/t1?version=7" });
    expect(headerOf(calls[0], "idempotency-key")).toBe("m-9");
  });

  it("maps deals and tasks to their API field names", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ data: {} }));

    await apiClient.pushMutation(mutation("deals", "save", { id: "d1", title: "Big", amount: "2500" }));
    await apiClient.pushMutation(mutation("tasks", "save", { id: "t1", title: "Do", assignee: "u2" }));

    expect(calls[0].body.amountCents).toBe(2500);
    expect(calls[1].body.assigneeUserId).toBe("u2");
  });

  it("sends invoices with ISO dates, zero tax and a paid amount only when paid", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ data: {} }));

    await apiClient.pushMutation(
      mutation("invoices", "save", { id: "i1", number: "F-1", status: "paid", amount: 1000, date: "2026-02-03T10:00:00Z", dueDate: "2026-03-03" }),
    );
    await apiClient.pushMutation(mutation("invoices", "save", { id: "i2", number: "F-2", status: "sent", amount: 1000, date: "2026-02-03" }));

    expect(calls[0].body).toMatchObject({
      issueDate: "2026-02-03",
      dueDate: "2026-03-03",
      subtotalCents: 1000,
      taxCents: 0,
      paidCents: 1000,
      currency: "MAD",
    });
    expect(calls[1].body.paidCents).toBe(0);
  });

  it("sends expenses with an ISO date and amount in cents", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ data: {} }));

    await apiClient.pushMutation(mutation("expenses", "save", { id: "x1", label: "Fuel", category: "transport", date: "2026-03-04", amount: 300 }));

    expect(calls[0].body).toMatchObject({ expenseDate: "2026-03-04", amountCents: 300, currency: "MAD" });
  });

  it("turns a read notification into the read endpoint, and ignores local-only stores", async () => {
    const { apiClient } = await load();
    const calls = stubFetch(() => json({ data: {} }));

    await apiClient.pushMutation(mutation("notifications", "save", { id: "n1", read: true }));
    const ignored = await apiClient.pushMutation(mutation("settings", "save", { id: "company" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/notifications/n1/read" });
    expect(ignored).toBeNull();
  });
});

describe("quotesApi", () => {
  it("lists with a limit and an optional search term, returning the data array", async () => {
    const { quotesApi } = await load();
    const calls = stubFetch(() => json({ data: [{ id: "q1" }] }));

    expect(await quotesApi.list({ q: "DV 2026" })).toEqual([{ id: "q1" }]);
    expect(calls[0].path).toBe("/quotes?limit=100&q=DV+2026");
    stubFetch(() => json({}));
    expect(await quotesApi.list()).toEqual([]);
  });

  it("sends the idempotency key on create and accept", async () => {
    const { quotesApi } = await load();
    const calls = stubFetch(() => json({ data: {} }, 201));

    await quotesApi.create({ number: "DV-1" }, "key-create");
    await quotesApi.accept("q1", { dueDate: "2026-12-31" }, "key-accept");

    expect(headerOf(calls[0], "idempotency-key")).toBe("key-create");
    expect(calls[1]).toMatchObject({ method: "POST", path: "/quotes/q1/accept" });
    expect(headerOf(calls[1], "idempotency-key")).toBe("key-accept");
  });
});
