import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyUnderPressure from "@fastify/under-pressure";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { loadConfig } from "./config.js";
import { AppError } from "./lib/errors.js";
import { authenticationPlugin } from "./plugins/authentication.js";
import { auditPlugin } from "./plugins/audit.js";
import { cachePlugin } from "./plugins/cache.js";
import { databasePlugin } from "./plugins/database.js";
import { observabilityPlugin } from "./plugins/observability.js";
import { storagePlugin } from "./plugins/storage.js";
import { authRoutes } from "./modules/auth/routes.js";
import { fileRoutes } from "./modules/files/routes.js";
import { insightRoutes } from "./modules/insights/routes.js";
import { resourceRoutes } from "./modules/resources/routes.js";
import { paymentRoutes } from "./modules/payments/routes.js";
import { quoteRoutes } from "./modules/quotes/routes.js";
import { teamRoutes } from "./modules/team/routes.js";

function corsOrigin(config) {
  return (origin, callback) => {
    if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed"), false);
  };
}

function publicError(error, request) {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      payload: {
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  if (error.validation) {
    return {
      statusCode: 400,
      payload: {
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
          requestId: request.id,
          details: error.validation.map(({ instancePath, message }) => ({ instancePath, message })),
        },
      },
    };
  }
  const databaseErrors = {
    23505: [409, "DUPLICATE_RECORD", "A record with the same unique value already exists"],
    23503: [400, "INVALID_RELATION", "A referenced record does not exist"],
    23514: [400, "INVALID_VALUE", "A value violates a business rule"],
    "22P02": [400, "INVALID_VALUE", "A supplied value has an invalid format"],
  };
  if (databaseErrors[error.code]) {
    const [statusCode, code, message] = databaseErrors[error.code];
    return { statusCode, payload: { error: { code, message, requestId: request.id } } };
  }
  if (error.code === "FST_REQ_FILE_TOO_LARGE") {
    return {
      statusCode: 413,
      payload: {
        error: {
          code: "FILE_TOO_LARGE",
          message: "File exceeds the 10 MB limit",
          requestId: request.id,
        },
      },
    };
  }
  if (error.code === "FST_UNDER_PRESSURE") {
    return {
      statusCode: 503,
      payload: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The service is temporarily overloaded. Retry shortly.",
          requestId: request.id,
        },
      },
    };
  }
  return {
    statusCode: 500,
    payload: {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId: request.id,
      },
    },
  };
}

export async function buildApp(options = {}) {
  const config = options.config || loadConfig(options.environment);
  const infrastructure = options.infrastructure !== false;
  const app = Fastify({
    logger: options.logger ?? {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.token",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.trustedProxies,
    bodyLimit: 1024 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    routerOptions: { maxParamLength: 200 },
  });
  app.decorate("config", config);

  await app.register(fastifyCookie, { secret: config.cookieSecret, hook: "onRequest" });
  await app.register(fastifyCors, {
    origin: corsOrigin(config),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-bootstrap-token"],
    maxAge: 600,
  });
  await app.register(fastifyHelmet, {
    global: true,
    contentSecurityPolicy: config.docsEnabled
      ? false
      : {
          directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        },
    hsts: config.isProduction
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
  });
  await app.register(fastifyUnderPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 1_500_000_000,
    maxRssBytes: 2_000_000_000,
    exposeStatusRoute: false,
  });

  if (config.docsEnabled) {
    await app.register(fastifySwagger, {
      openapi: {
        info: { title: "MoroccoFlow API", version: "1.0.0" },
        servers: [{ url: "/api/v1" }],
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
      },
    });
    await app.register(fastifySwaggerUi, { routePrefix: "/documentation" });
  }

  // Liveness answers "is this process alive", never "is it busy". Leaving it
  // behind under-pressure means a merely-loaded process reports itself dead, and
  // an orchestrator then restarts it at exactly the moment it is busiest. The
  // empty pressureHandler is under-pressure's own per-route opt-out: returning
  // nothing lets the request through. Load belongs on readiness, not liveness.
  app.get(
    "/health/live",
    { schema: { hide: true }, config: { pressureHandler: () => undefined } },
    async () => ({ status: "ok" }),
  );

  if (infrastructure) {
    await databasePlugin(app, { config });
    await cachePlugin(app, { config });
    await storagePlugin(app, { config });
    await app.register(fastifyRateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
      redis: app.redis,
      keyGenerator: (request) => request.auth?.userId || request.ip,
      errorResponseBuilder: (request, context) => ({
        error: {
          code: "RATE_LIMITED",
          message: `Too many requests; retry in ${context.after}`,
          requestId: request.id,
        },
      }),
    });
    await app.register(fastifyMultipart, {
      limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 10, parts: 11 },
      throwFileSizeLimit: true,
    });
    await authenticationPlugin(app, { config });
    await auditPlugin(app);
    await observabilityPlugin(app, { config });

    app.get("/health/ready", { schema: { hide: true } }, async (request, reply) => {
      try {
        const [database] = await Promise.all([
          app.databaseReady(),
          app.redis.ping(),
          app.storage.send(new HeadBucketCommand({ Bucket: config.s3.bucket })),
        ]);
        if (!database) throw new Error("Database is not ready");
        return { status: "ready" };
      } catch (error) {
        request.log.warn({ err: error }, "Readiness check failed");
        return reply.code(503).send({ status: "not-ready", requestId: request.id });
      }
    });

    await app.register(authRoutes, { prefix: "/api/v1/auth" });
    await app.register(resourceRoutes, { prefix: "/api/v1" });
    await app.register(teamRoutes, { prefix: "/api/v1" });
    await app.register(insightRoutes, { prefix: "/api/v1" });
    await app.register(fileRoutes, { prefix: "/api/v1" });
    await app.register(quoteRoutes, { prefix: "/api/v1" });
    await app.register(paymentRoutes, { prefix: "/api/v1" });
  }

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: "NOT_FOUND", message: "Route not found", requestId: request.id },
    }),
  );
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, payload } = publicError(error, request);
    if (statusCode >= 500) request.log.error({ err: error }, "Unhandled request error");
    else request.log.info({ err: error, statusCode }, "Request rejected");
    return reply.code(statusCode).send(payload);
  });

  return app;
}
