import { randomUUID } from "node:crypto";
import {
  createMfaSecret,
  createOpaqueToken,
  decryptMfaSecret,
  encryptMfaSecret,
  hashPassword,
  hashToken,
  normalizeEmail,
  safeTokenEqual,
  verifyPassword,
  verifyTotp,
} from "../../lib/crypto.js";
import { AppError, conflict } from "../../lib/errors.js";
import { toPublicJson } from "../../lib/serialize.js";
import { rolePermissions } from "../../lib/rbac.js";

const REFRESH_COOKIE = "mf_refresh";
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

function cookieOptions(config) {
  return {
    path: "/api/v1/auth",
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    maxAge: config.refreshTokenDays * 24 * 60 * 60,
  };
}

function checkOrigin(request, config) {
  const origin = request.headers.origin;
  if (origin && !config.corsOrigins.includes(origin)) {
    throw new AppError("INVALID_ORIGIN", "Request origin is not allowed", 403);
  }
}

async function createSession(app, client, auth, request) {
  const sessionId = randomUUID();
  const refreshToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + app.config.refreshTokenDays * 86_400_000);
  await client.query(
    `INSERT INTO refresh_tokens
       (id, tenant_id, user_id, token_hash, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5,
       encode(digest(COALESCE($6, ''), 'sha256'), 'hex'), $7)`,
    [
      sessionId,
      auth.tenantId,
      auth.userId,
      hashToken(refreshToken),
      request.headers["user-agent"]?.slice(0, 300),
      request.ip,
      expiresAt,
    ],
  );
  const accessToken = app.jwt.sign(
    { tenantId: auth.tenantId, role: auth.role, sessionId },
    { sub: auth.userId },
  );
  return { accessToken, refreshToken, expiresAt, sessionId };
}

function publicUser(row) {
  return toPublicJson({
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    department: row.department,
    status: row.status,
    tenant_id: row.tenant_id,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
    permissions: rolePermissions[row.role] || [],
  });
}

export async function authRoutes(app) {
  const strongPassword = {
    type: "string",
    minLength: 12,
    maxLength: 128,
    pattern: "^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).+$",
  };
  const credentials = {
    type: "object",
    additionalProperties: false,
    required: ["workspace", "email", "password"],
    properties: {
      workspace: { type: "string", minLength: 3, maxLength: 63, pattern: "^[a-z0-9][a-z0-9-]+$" },
      email: { type: "string", format: "email", maxLength: 254 },
      password: { type: "string", minLength: 1, maxLength: 128 },
      mfaCode: { type: "string", pattern: "^[0-9]{6}$" },
    },
  };

  const dummyHash = await hashPassword("MoroccoFlow-Dummy-Password-2026!");

  app.post(
    "/bootstrap",
    {
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["workspace", "companyName", "ownerName", "email", "password"],
          properties: {
            workspace: {
              type: "string",
              minLength: 3,
              maxLength: 63,
              pattern: "^[a-z0-9][a-z0-9-]+$",
            },
            companyName: { type: "string", minLength: 2, maxLength: 160 },
            legalName: { type: "string", maxLength: 200 },
            ownerName: { type: "string", minLength: 2, maxLength: 160 },
            email: { type: "string", format: "email", maxLength: 254 },
            password: strongPassword,
            ice: { type: "string", pattern: "^[0-9]{15}$" },
            city: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const supplied = request.headers["x-bootstrap-token"] || "";
      if (!safeTokenEqual(supplied, app.config.bootstrapToken)) {
        throw new AppError("NOT_FOUND", "Not found", 404);
      }
      const tenantId = randomUUID();
      const userId = randomUUID();
      const passwordHash = await hashPassword(request.body.password);
      const auth = { tenantId, userId, role: "owner" };

      return app.withTenant(auth, async (client) => {
        try {
          await client.query(
            `INSERT INTO tenants (id, slug, name, legal_name, ice, city)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              tenantId,
              request.body.workspace,
              request.body.companyName,
              request.body.legalName || null,
              request.body.ice || null,
              request.body.city || null,
            ],
          );
          await client.query(
            `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
             VALUES ($1, $2, $3, $4, $5, 'owner')`,
            [
              userId,
              tenantId,
              normalizeEmail(request.body.email),
              passwordHash,
              request.body.ownerName,
            ],
          );
        } catch (error) {
          if (error.code === "23505") throw conflict("Workspace or email already exists");
          throw error;
        }
        await app.writeAudit(client, auth, {
          action: "tenant.bootstrapped",
          entityType: "tenant",
          entityId: tenantId,
          after: { name: request.body.companyName, ownerUserId: userId },
          request,
        });
        return reply
          .code(201)
          .send({ data: { tenantId, userId, workspace: request.body.workspace } });
      });
    },
  );

  app.post(
    "/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: { tags: ["Auth"], body: credentials },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const result = await app.withRuntimeRole((client) =>
        client.query("SELECT * FROM auth_lookup($1::citext, $2::citext)", [
          request.body.workspace,
          email,
        ]),
      );
      const account = result.rows[0];
      const valid = account
        ? await verifyPassword(account.password_hash, request.body.password)
        : await verifyPassword(dummyHash, request.body.password);
      if (!account || !valid || account.status !== "active") {
        if (account) {
          await app.withTenant(
            { tenantId: account.tenant_id, userId: account.user_id, role: account.role },
            async (client) => {
              await client.query(
                `UPDATE users SET failed_login_count = failed_login_count + 1,
                   locked_until = CASE WHEN failed_login_count + 1 >= $2
                     THEN now() + make_interval(mins => $3) ELSE locked_until END
                 WHERE id = $1`,
                [account.user_id, MAX_FAILURES, LOCK_MINUTES],
              );
            },
          );
        }
        throw new AppError("INVALID_CREDENTIALS", "Workspace, email or password is incorrect", 401);
      }
      if (account.locked_until && new Date(account.locked_until) > new Date()) {
        throw new AppError("ACCOUNT_LOCKED", "Account is temporarily locked", 423);
      }
      if (account.mfa_enabled) {
        const mfa = await app.withTenant(
          { tenantId: account.tenant_id, userId: account.user_id, role: account.role },
          (client) =>
            client.query("SELECT mfa_secret_encrypted FROM users WHERE id = $1", [account.user_id]),
        );
        let mfaValid;
        try {
          const secret = decryptMfaSecret(
            mfa.rows[0]?.mfa_secret_encrypted,
            app.config.mfaEncryptionKey,
          );
          mfaValid = verifyTotp(secret, request.body.mfaCode);
        } catch {
          mfaValid = false;
        }
        if (!mfaValid) {
          throw new AppError(
            "MFA_REQUIRED",
            "A valid six-digit authentication code is required",
            403,
          );
        }
      }

      const auth = {
        tenantId: account.tenant_id,
        userId: account.user_id,
        role: account.role,
      };
      const session = await app.withTenant(auth, async (client) => {
        await client.query(
          "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
          [auth.userId],
        );
        const created = await createSession(app, client, auth, request);
        await app.writeAudit(
          client,
          { ...auth, sessionId: created.sessionId },
          {
            action: "auth.login",
            entityType: "session",
            entityId: created.sessionId,
            request,
          },
        );
        return created;
      });
      reply.setCookie(REFRESH_COOKIE, session.refreshToken, cookieOptions(app.config));
      return { data: { accessToken: session.accessToken, expiresAt: session.expiresAt } };
    },
  );

  app.post(
    "/refresh",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } }, schema: { tags: ["Auth"] } },
    async (request, reply) => {
      checkOrigin(request, app.config);
      const rawToken = request.cookies[REFRESH_COOKIE];
      if (!rawToken) throw new AppError("UNAUTHORIZED", "Refresh session is required", 401);
      const lookup = await app.withRuntimeRole((client) =>
        client.query("SELECT * FROM refresh_token_lookup($1::char(64))", [hashToken(rawToken)]),
      );
      const previous = lookup.rows[0];
      if (
        !previous ||
        previous.revoked_at ||
        previous.user_status !== "active" ||
        new Date(previous.expires_at) <= new Date()
      ) {
        reply.clearCookie(REFRESH_COOKIE, cookieOptions(app.config));
        throw new AppError("UNAUTHORIZED", "Refresh session is invalid", 401);
      }
      const auth = {
        tenantId: previous.tenant_id,
        userId: previous.user_id,
        role: previous.role,
      };
      const session = await app.withTenant(auth, async (client) => {
        const created = await createSession(app, client, auth, request);
        const revoked = await client.query(
          `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2
           WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
          [previous.token_id, created.sessionId],
        );
        if (!revoked.rowCount)
          throw new AppError("UNAUTHORIZED", "Refresh session was reused", 401);
        return created;
      });
      reply.setCookie(REFRESH_COOKIE, session.refreshToken, cookieOptions(app.config));
      return { data: { accessToken: session.accessToken, expiresAt: session.expiresAt } };
    },
  );

  app.post(
    "/logout",
    { preHandler: app.authenticate, schema: { tags: ["Auth"] } },
    async (request, reply) => {
      checkOrigin(request, app.config);
      const rawToken = request.cookies[REFRESH_COOKIE];
      await app.withTenant(request.auth, async (client) => {
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
           WHERE id = $1 OR ($2::text IS NOT NULL AND token_hash = $2)`,
          [request.auth.sessionId, rawToken ? hashToken(rawToken) : null],
        );
      });
      reply.clearCookie(REFRESH_COOKIE, cookieOptions(app.config));
      return reply.code(204).send();
    },
  );

  app.post(
    "/mfa/setup",
    { preHandler: app.authenticate, schema: { tags: ["Auth"] } },
    async (request) =>
      app.withTenant(request.auth, async (client) => {
        const account = await client.query(
          `SELECT u.email, u.mfa_enabled, t.slug
           FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
          [request.auth.userId],
        );
        if (account.rows[0]?.mfa_enabled) {
          throw new AppError(
            "MFA_ALREADY_ENABLED",
            "Multi-factor authentication is already enabled",
            409,
          );
        }
        const secret = createMfaSecret();
        const encrypted = encryptMfaSecret(secret, app.config.mfaEncryptionKey);
        await client.query("UPDATE users SET mfa_secret_encrypted = $2 WHERE id = $1", [
          request.auth.userId,
          encrypted,
        ]);
        const label = encodeURIComponent(`${account.rows[0].slug}:${account.rows[0].email}`);
        const issuer = encodeURIComponent("MoroccoFlow");
        return {
          data: {
            secret,
            otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
          },
        };
      }),
  );

  app.post(
    "/mfa/confirm",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: { code: { type: "string", pattern: "^[0-9]{6}$" } },
        },
      },
    },
    async (request, reply) =>
      app.withTenant(request.auth, async (client) => {
        const result = await client.query("SELECT mfa_secret_encrypted FROM users WHERE id = $1", [
          request.auth.userId,
        ]);
        if (!result.rows[0]?.mfa_secret_encrypted) {
          throw new AppError("MFA_SETUP_REQUIRED", "Start MFA setup before confirmation", 400);
        }
        const secret = decryptMfaSecret(
          result.rows[0].mfa_secret_encrypted,
          app.config.mfaEncryptionKey,
        );
        if (!verifyTotp(secret, request.body.code)) {
          throw new AppError("INVALID_MFA_CODE", "Authentication code is invalid", 400);
        }
        await client.query("UPDATE users SET mfa_enabled = true WHERE id = $1", [
          request.auth.userId,
        ]);
        await app.writeAudit(client, request.auth, {
          action: "auth.mfa_enabled",
          entityType: "user",
          entityId: request.auth.userId,
          request,
        });
        return reply.code(204).send();
      }),
  );

  app.post(
    "/mfa/disable",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["password", "code"],
          properties: {
            password: { type: "string", minLength: 1, maxLength: 128 },
            code: { type: "string", pattern: "^[0-9]{6}$" },
          },
        },
      },
    },
    async (request, reply) =>
      app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          "SELECT password_hash, mfa_secret_encrypted, mfa_enabled FROM users WHERE id = $1",
          [request.auth.userId],
        );
        const account = result.rows[0];
        const passwordValid = await verifyPassword(account?.password_hash, request.body.password);
        let codeValid;
        try {
          codeValid = verifyTotp(
            decryptMfaSecret(account?.mfa_secret_encrypted, app.config.mfaEncryptionKey),
            request.body.code,
          );
        } catch {
          codeValid = false;
        }
        if (!account?.mfa_enabled || !passwordValid || !codeValid) {
          throw new AppError(
            "MFA_VERIFICATION_FAILED",
            "Password or authentication code is invalid",
            403,
          );
        }
        await client.query(
          "UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL WHERE id = $1",
          [request.auth.userId],
        );
        await app.writeAudit(client, request.auth, {
          action: "auth.mfa_disabled",
          entityType: "user",
          entityId: request.auth.userId,
          request,
        });
        return reply.code(204).send();
      }),
  );
  app.post(
    "/accept-invitation",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token", "password"],
          properties: {
            token: { type: "string", minLength: 40, maxLength: 200 },
            password: strongPassword,
          },
        },
      },
    },
    async (request, reply) => {
      const lookup = await app.withRuntimeRole((client) =>
        client.query("SELECT * FROM invitation_lookup($1::char(64))", [
          hashToken(request.body.token),
        ]),
      );
      const invitation = lookup.rows[0];
      if (!invitation || invitation.accepted_at || new Date(invitation.expires_at) <= new Date()) {
        throw new AppError("INVALID_INVITATION", "Invitation is invalid or expired", 400);
      }
      const userId = randomUUID();
      const auth = {
        tenantId: invitation.tenant_id,
        userId,
        role: invitation.role,
      };
      const passwordHash = await hashPassword(request.body.password);
      await app.withTenant(auth, async (client) => {
        try {
          await client.query(
            `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              userId,
              invitation.tenant_id,
              invitation.email,
              passwordHash,
              invitation.full_name,
              invitation.role,
            ],
          );
        } catch (error) {
          if (error.code === "23505") throw conflict("This invitation has already been accepted");
          throw error;
        }
        const accepted = await client.query(
          `UPDATE user_invitations SET accepted_at = now()
           WHERE id = $1 AND accepted_at IS NULL RETURNING id`,
          [invitation.invitation_id],
        );
        if (!accepted.rowCount) throw conflict("This invitation has already been accepted");
        await app.writeAudit(client, auth, {
          action: "invitation.accepted",
          entityType: "user",
          entityId: userId,
          after: { email: invitation.email, role: invitation.role },
          request,
        });
      });
      return reply.code(201).send({ data: { userId } });
    },
  );
  app.get("/me", { preHandler: app.authenticate, schema: { tags: ["Auth"] } }, async (request) =>
    app.withTenant(request.auth, async (client) => {
      const result = await client.query(
        `SELECT u.id, u.email, u.full_name, u.role, u.department, u.status,
                u.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.id = $1`,
        [request.auth.userId],
      );
      if (!result.rowCount) throw new AppError("UNAUTHORIZED", "Account is unavailable", 401);
      return { data: publicUser(result.rows[0]) };
    }),
  );
}
