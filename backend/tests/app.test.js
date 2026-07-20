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
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
  });
});
