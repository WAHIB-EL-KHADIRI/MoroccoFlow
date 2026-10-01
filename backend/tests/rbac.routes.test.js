/**
 * Authorisation is only real if the *server* refuses the request. A disabled
 * button proves nothing: anyone can replay a request with curl.
 *
 * This suite mounts the real route tree (auth, resources, team, insights,
 * files) on the real authentication plugin, and replaces only the data layer
 * with a sentinel. The sentinel is the point: `withTenant` throws a 599, so a
 * route whose guard is missing or wrong announces itself with a status code
 * that cannot be produced by any legitimate path.
 *
 * What is covered here:
 *   1. every mutating route under /api/v1 refuses an anonymous caller;
 *   2. a `viewer` is refused with 403 on every mutating route;
 *   3. each write namespace admits exactly the roles rolePermissions declares;
 *   4. forged, truncated and mis-signed tokens are all rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fastifyMultipart from "@fastify/multipart";
import { buildApp } from "../src/app.js";
import { AppError } from "../src/lib/errors.js";
import { authenticationPlugin } from "../src/plugins/authentication.js";
import { authRoutes, signAccessToken } from "../src/modules/auth/routes.js";
import { fileRoutes } from "../src/modules/files/routes.js";
import { insightRoutes } from "../src/modules/insights/routes.js";
import { resourceRoutes } from "../src/modules/resources/routes.js";
import { teamRoutes } from "../src/modules/team/routes.js";
import { paymentRoutes } from "../src/modules/payments/routes.js";
import { quoteRoutes } from "../src/modules/quotes/routes.js";

/** Any handler that reaches the data layer answers with this status. */
const HANDLER_REACHED = 599;

const TENANT = "3f1d1a88-0a6a-4f2f-9e43-6f14f0a1b111";
const ACTOR = "a4b0c1d2-7e5f-4a3b-8c9d-0e1f2a3b4c5d";
const TARGET = "b7c8d9e0-1f2a-4b3c-8d9e-0f1a2b3c4d5e";

const mutating = new Set(["POST", "PATCH", "DELETE"]);

/**
 * Routes that are unauthenticated *by design*. Listing them explicitly means a
 * new public route cannot be introduced silently: it fails the sweep until an
 * author adds it here, which is a decision someone has to make on purpose.
 */
const publicRoutes = new Set([
  "POST /api/v1/auth/bootstrap",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/accept-invitation",
]);

/**
 * Authenticated by a shared scanner token rather than a user session, so it
 * answers 404 (not 401) to a caller that does not hold the token.
 */
const webhookRoute = "POST /api/v1/internal/files/scan-result";

/** Schema validation runs *before* preHandler, so every probe needs a body
 *  that would otherwise be accepted; a 400 would mask the authorisation check. */
const fixtures = {
  "POST /api/v1/clients": { body: { name: "Probe", company: "Probe SARL" } },
  "PATCH /api/v1/clients/:id": { body: { version: 1, name: "Renamed" } },
  "DELETE /api/v1/clients/:id": { query: "version=1" },
  "POST /api/v1/deals": { body: { clientId: TARGET, title: "Probe", stage: "contact" } },
  "PATCH /api/v1/deals/:id": { body: { version: 1, title: "Renamed" } },
  "DELETE /api/v1/deals/:id": { query: "version=1" },
  "POST /api/v1/projects": { body: { name: "Probe" } },
  "PATCH /api/v1/projects/:id": { body: { version: 1, name: "Renamed" } },
  "DELETE /api/v1/projects/:id": { query: "version=1" },
  "POST /api/v1/tasks": { body: { projectId: TARGET, title: "Probe" } },
  "PATCH /api/v1/tasks/:id": { body: { version: 1, title: "Renamed" } },
  "DELETE /api/v1/tasks/:id": { query: "version=1" },
  "POST /api/v1/quotes": {
    body: { clientId: TARGET, number: "DV-2026-001", issueDate: "2026-01-05" },
  },
  "PATCH /api/v1/quotes/:id": { body: { version: 1, status: "sent" } },
  "DELETE /api/v1/quotes/:id": { query: "version=1" },
  "POST /api/v1/quotes/:id/accept": { body: { dueDate: "2026-02-05" } },
  "POST /api/v1/payment-obligations/:id/payments": {
    body: { amountCents: 100, paidOn: "2026-01-05" },
  },
  "POST /api/v1/invoices": {
    body: {
      clientId: TARGET,
      number: "FA-2026-001",
      issueDate: "2026-01-05",
      dueDate: "2026-02-05",
    },
  },
  "PATCH /api/v1/invoices/:id": { body: { version: 1, status: "sent" } },
  "DELETE /api/v1/invoices/:id": { query: "version=1" },
  "POST /api/v1/expenses": {
    body: { label: "Carburant", category: "transport", expenseDate: "2026-01-05" },
  },
  "PATCH /api/v1/expenses/:id": { body: { version: 1, label: "Carburant Casa" } },
  "DELETE /api/v1/expenses/:id": { query: "version=1" },
  "POST /api/v1/team/invitations": {
    body: { email: "probe@example.test", fullName: "Probe Member", role: "viewer" },
  },
  "PATCH /api/v1/team/:id": { body: { version: 1, role: "viewer" } },
  "POST /api/v1/notifications": { body: { type: "info", title: "Probe" } },
  "PATCH /api/v1/notifications/:id/read": {},
  "POST /api/v1/files": {},
  [webhookRoute]: { body: { tenantId: TENANT, fileId: TARGET, status: "clean" } },
  "POST /api/v1/auth/logout": {},
  "POST /api/v1/auth/mfa/setup": {},
  "POST /api/v1/auth/mfa/confirm": { body: { code: "123456" } },
  "POST /api/v1/auth/mfa/disable": { body: { code: "123456", password: "irrelevant-probe" } },
};

let app;
const routes = [];

function inject(route, token) {
  const fixture = fixtures[`${route.method} ${route.url}`] ?? {};
  const url = route.url.replace(":id", TARGET) + (fixture.query ? `?${fixture.query}` : "");
  return app.inject({
    method: route.method,
    url,
    ...(fixture.body ? { payload: fixture.body } : {}),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

/** Signed through the API's own helper, so these probes carry exactly the
 *  token a real login hands out -- not a shape invented by the test. */
function tokenFor(role, userId = ACTOR) {
  return signAccessToken(app, { userId, tenantId: TENANT, role, sessionId: TARGET });
}

beforeAll(async () => {
  app = await buildApp({ infrastructure: false, logger: false });

  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (mutating.has(method)) routes.push({ method, url: route.url });
    }
  });

  // The data layer is the sentinel: reaching it at all means every guard in
  // front of it let the request through.
  app.decorate("withTenant", async () => {
    throw new AppError("HANDLER_REACHED", "The route handler was executed", HANDLER_REACHED);
  });
  app.decorate("withRuntimeRole", async () => {
    throw new AppError("HANDLER_REACHED", "The route handler was executed", HANDLER_REACHED);
  });
  app.decorate("writeAudit", async () => {});
  app.decorate("storage", { send: async () => ({}) });

  await app.register(fastifyMultipart, { limits: { files: 1, fileSize: 1024 } });
  await authenticationPlugin(app, { config: app.config });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(resourceRoutes, { prefix: "/api/v1" });
  await app.register(teamRoutes, { prefix: "/api/v1" });
  await app.register(insightRoutes, { prefix: "/api/v1" });
  await app.register(fileRoutes, { prefix: "/api/v1" });
  await app.register(quoteRoutes, { prefix: "/api/v1" });
  await app.register(paymentRoutes, { prefix: "/api/v1" });
  await app.ready();

  // Booting the auth module runs an Argon2 hash, which blocks the event loop
  // long enough for @fastify/under-pressure to answer 503 until its sampler
  // next observes a free loop. Poll until it has, rather than asserting against
  // a stale measurement -- a bounded retry, not a sleep.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const probe = await app.inject({ method: "GET", url: "/api/v1/clients" });
    if (probe.statusCode !== 503) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

afterAll(async () => app?.close());

describe("anonymous callers cannot mutate anything", () => {
  it("has a route table to sweep, and a fixture for every route in it", () => {
    // A silently empty sweep would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThanOrEqual(25);
    const missing = routes
      .map((route) => `${route.method} ${route.url}`)
      .filter((key) => !publicRoutes.has(key) && !(key in fixtures));
    expect(missing).toEqual([]);
  });

  it("refuses every mutating route without a session", async () => {
    const outcomes = [];
    for (const route of routes) {
      const key = `${route.method} ${route.url}`;
      if (publicRoutes.has(key)) continue;
      const response = await inject(route);
      outcomes.push(`${key} -> ${response.statusCode} ${response.json().error?.code}`);
    }
    // 404 for the scanner webhook: it must not confirm that the endpoint exists
    // to a caller without the token.
    expect(outcomes).toEqual(
      outcomes.map((line) =>
        line.startsWith(webhookRoute) ? line : line.replace(/-> .*/, "-> 401 UNAUTHORIZED"),
      ),
    );
    expect(outcomes).toContain(`${webhookRoute} -> 404 NOT_FOUND`);
    expect(outcomes.filter((line) => line.includes("401 UNAUTHORIZED")).length).toBeGreaterThan(20);
  });
});

describe("role enforcement at the API, not at the button", () => {
  /** Every mutating route a viewer must never reach, with the role that may. */
  const matrix = [
    { key: "POST /api/v1/clients", allow: ["owner", "admin", "sales"], deny: ["finance", "hr"] },
    { key: "PATCH /api/v1/clients/:id", allow: ["admin", "sales"], deny: ["finance", "hr"] },
    { key: "DELETE /api/v1/clients/:id", allow: ["admin", "sales"], deny: ["finance", "hr"] },
    { key: "POST /api/v1/deals", allow: ["owner", "sales"], deny: ["project_manager", "hr"] },
    {
      key: "POST /api/v1/projects",
      allow: ["owner", "admin", "project_manager"],
      deny: ["sales", "finance", "hr"],
    },
    {
      key: "POST /api/v1/tasks",
      allow: ["project_manager"],
      deny: ["sales", "finance", "hr"],
    },
    {
      key: "POST /api/v1/quotes",
      allow: ["owner", "admin", "finance", "sales"],
      deny: ["project_manager", "hr"],
    },
    {
      key: "PATCH /api/v1/quotes/:id",
      allow: ["sales", "finance"],
      deny: ["project_manager", "hr"],
    },
    {
      key: "DELETE /api/v1/quotes/:id",
      allow: ["sales"],
      deny: ["project_manager", "hr"],
    },
    {
      key: "POST /api/v1/invoices",
      allow: ["owner", "admin", "finance"],
      deny: ["sales", "project_manager", "hr"],
    },
    {
      key: "PATCH /api/v1/invoices/:id",
      allow: ["finance"],
      deny: ["sales", "project_manager", "hr"],
    },
    {
      key: "DELETE /api/v1/invoices/:id",
      allow: ["finance"],
      deny: ["sales", "project_manager", "hr"],
    },
    {
      key: "POST /api/v1/quotes/:id/accept",
      allow: ["owner", "admin", "finance", "sales"],
      deny: ["project_manager", "hr"],
    },
    {
      key: "POST /api/v1/payment-obligations/:id/payments",
      allow: ["owner", "admin", "finance"],
      deny: ["sales", "project_manager", "hr"],
    },
    {
      key: "POST /api/v1/expenses",
      allow: ["owner", "admin", "finance"],
      deny: ["sales", "project_manager", "hr"],
    },
    {
      key: "POST /api/v1/team/invitations",
      allow: ["owner", "admin", "hr"],
      deny: ["sales", "finance", "project_manager"],
    },
    {
      key: "PATCH /api/v1/team/:id",
      allow: ["owner", "admin", "hr"],
      deny: ["sales", "finance", "project_manager"],
    },
    {
      key: "POST /api/v1/notifications",
      allow: ["owner", "admin", "hr"],
      deny: ["sales", "finance", "project_manager"],
    },
  ];

  it("refuses a viewer on every mutating business route", async () => {
    const refusals = [];
    for (const { key } of matrix) {
      const [method, url] = key.split(" ");
      const response = await inject({ method, url }, tokenFor("viewer"));
      refusals.push(`${key} -> ${response.statusCode} ${response.json().error.code}`);
    }
    expect(refusals).toEqual(matrix.map(({ key }) => `${key} -> 403 FORBIDDEN`));
  });

  it("refuses every role the permission table does not grant", async () => {
    const refusals = [];
    for (const { key, deny } of matrix) {
      const [method, url] = key.split(" ");
      for (const role of deny) {
        const response = await inject({ method, url }, tokenFor(role));
        refusals.push(`${role} ${key} -> ${response.statusCode} ${response.json().error.code}`);
      }
    }
    expect(refusals).toEqual(
      matrix.flatMap(({ key, deny }) => deny.map((role) => `${role} ${key} -> 403 FORBIDDEN`)),
    );
  });

  it("lets every granted role through to the handler", async () => {
    // Without this the 403s above could be produced by something other than the
    // permission check -- a typo in a URL would "pass" the refusal tests.
    const admissions = [];
    for (const { key, allow } of matrix) {
      const [method, url] = key.split(" ");
      for (const role of allow) {
        const response = await inject({ method, url }, tokenFor(role));
        admissions.push(`${role} ${key} -> ${response.statusCode}`);
      }
    }
    expect(admissions).toEqual(
      matrix.flatMap(({ key, allow }) =>
        allow.map((role) => `${role} ${key} -> ${HANDLER_REACHED}`),
      ),
    );
  });

  it("still lets a viewer acknowledge their own notification", async () => {
    // Marking a notification read is scoped to the caller in SQL, so it is
    // authenticated but deliberately not permission-gated. Asserting it keeps
    // the sweep above from being "tighten everything until nothing works".
    const response = await inject(
      { method: "PATCH", url: "/api/v1/notifications/:id/read" },
      tokenFor("viewer"),
    );
    expect(response.statusCode).toBe(HANDLER_REACHED);
  });

  it("refuses an unknown role outright", async () => {
    const response = await inject(
      { method: "POST", url: "/api/v1/clients" },
      tokenFor("superadmin"),
    );
    expect(response.statusCode).toBe(403);
  });
});

describe("token integrity", () => {
  it("issues an access token the API's own verifier accepts", async () => {
    // Regression: `app.jwt.sign(payload, { sub })` does not merge with the
    // plugin's sign options under @fastify/jwt 10 -- it replaces them. Login
    // therefore issued an HS256 token with no iss, no aud and no exp, which the
    // verifier rejected, so no access token worked at all and the one handed
    // out never expired. Assert the claims, not just that a request succeeds.
    const token = tokenFor("owner");
    const [header, payload] = token
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));

    expect(header.alg).toBe("HS512");
    expect(payload).toMatchObject({
      sub: ACTOR,
      tenantId: TENANT,
      role: "owner",
      sessionId: TARGET,
      iss: "moroccoflow-api",
      aud: "moroccoflow-web",
    });
    expect(payload.exp).toBeGreaterThan(payload.iat);

    const response = await inject({ method: "POST", url: "/api/v1/clients" }, token);
    expect(response.statusCode).toBe(HANDLER_REACHED);
  });

  it("rejects a token signed with another secret", async () => {
    const foreign = await buildApp({
      infrastructure: false,
      logger: false,
      config: { ...app.config, jwtSecret: "f".repeat(64) },
    });
    await authenticationPlugin(foreign, { config: foreign.config });
    const forged = signAccessToken(foreign, {
      userId: ACTOR,
      tenantId: TENANT,
      role: "owner",
      sessionId: TARGET,
    });
    await foreign.close();

    const response = await inject({ method: "POST", url: "/api/v1/clients" }, forged);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects an unsigned 'alg: none' token", async () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      sub: ACTOR,
      tenantId: TENANT,
      role: "owner",
      sessionId: TARGET,
      iss: "moroccoflow-api",
      aud: "moroccoflow-web",
    })}.`;

    const response = await inject({ method: "POST", url: "/api/v1/clients" }, unsigned);
    expect(response.statusCode).toBe(401);
  });

  it("rejects a well-signed token that is missing tenant, role or session", async () => {
    const incomplete = [
      app.jwt.sign({ sub: ACTOR, role: "owner", sessionId: TARGET }),
      app.jwt.sign({ sub: ACTOR, tenantId: TENANT, sessionId: TARGET }),
      app.jwt.sign({ sub: ACTOR, tenantId: TENANT, role: "owner" }),
      app.jwt.sign({ tenantId: TENANT, role: "owner", sessionId: TARGET }),
    ];
    for (const token of incomplete) {
      const response = await inject({ method: "POST", url: "/api/v1/clients" }, token);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHORIZED");
    }
  });
});
