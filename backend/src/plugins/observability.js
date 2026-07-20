import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { safeTokenEqual } from "../lib/crypto.js";

export async function observabilityPlugin(app, options) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "moroccoflow_" });

  const requests = new Counter({
    name: "moroccoflow_http_requests_total",
    help: "HTTP requests processed",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "moroccoflow_http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  app.addHook("onRequest", async (request) => {
    request.metricsStartedAt = process.hrtime.bigint();
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url || "unknown";
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    requests.inc(labels);
    if (request.metricsStartedAt) {
      const seconds = Number(process.hrtime.bigint() - request.metricsStartedAt) / 1e9;
      duration.observe(labels, seconds);
    }
  });

  app.get("/metrics", { logLevel: "warn" }, async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
    if (!safeTokenEqual(token, options.config.metricsToken)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    }
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
