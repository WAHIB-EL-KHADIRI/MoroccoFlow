import fastifyJwt from "@fastify/jwt";
import { AppError } from "../lib/errors.js";
import { assertPermission } from "../lib/rbac.js";

export async function authenticationPlugin(app, options) {
  await app.register(fastifyJwt, {
    secret: options.config.jwtSecret,
    sign: {
      algorithm: "HS512",
      iss: "moroccoflow-api",
      aud: "moroccoflow-web",
      expiresIn: options.config.accessTokenTtl,
    },
    verify: {
      allowedIss: "moroccoflow-api",
      allowedAud: "moroccoflow-web",
      algorithms: ["HS512"],
    },
  });

  app.decorate("authenticate", async function authenticate(request) {
    try {
      await request.jwtVerify();
      const { sub, tenantId, role, sessionId } = request.user;
      if (!sub || !tenantId || !role || !sessionId) throw new Error("Incomplete token");
      request.auth = { userId: sub, tenantId, role, sessionId };
    } catch {
      throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
    }
  });

  app.decorate("requirePermission", function requirePermission(permission) {
    return async function permissionGuard(request) {
      await app.authenticate(request);
      assertPermission(request.auth.role, permission);
    };
  });
}
