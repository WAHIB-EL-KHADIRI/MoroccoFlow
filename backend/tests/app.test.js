import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

let app;
afterEach(async () => app?.close());

describe("HTTP perimeter", () => {
  it("serves liveness with security headers", async () => {
    app = await buildApp({ infrastructure: false, logger: false });
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("returns stable errors without stack traces", async () => {
    app = await buildApp({ infrastructure: false, logger: false });
    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBeTruthy();
    expect(response.body).not.toContain("stack");
  });

  it("rejects untrusted browser origins", async () => {
    app = await buildApp({ infrastructure: false, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "https://attacker.invalid" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("INVALID_ORIGIN");
  });
});

describe("behaviour under event-loop pressure", () => {
  // under-pressure samples the event loop on a timer, so block the loop past
  // maxEventLoopDelay (1000ms) and give the sampler a tick to observe it. This
  // is the same condition a cold, parallel `npm run check` created by accident,
  // which is what made this suite flaky.
  async function applyPressure() {
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      /* block the loop */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it("keeps liveness green while the process is merely busy", async () => {
    app = await buildApp({ infrastructure: false, logger: false });
    await app.ready();
    await applyPressure();

    const response = await app.inject({ method: "GET", url: "/health/live" });

    // Liveness must not fail under load: an orchestrator reads a failed probe
    // as "restart this container", which is the worst possible response to a
    // process that is simply busy.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  }, 20_000);

  it("rejects other routes with 503, not a masked 500", async () => {
    app = await buildApp({ infrastructure: false, logger: false });
    app.get("/pressure-probe", async () => ({ ok: true }));
    await app.ready();
    await applyPressure();

    const response = await app.inject({ method: "GET", url: "/pressure-probe" });

    // 503 tells a proxy to retry elsewhere; 500 tells it the request itself is
    // broken. The error handler used to flatten every unrecognised error to 500,
    // which swallowed under-pressure's status.
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("SERVICE_UNAVAILABLE");
  }, 20_000);
});
