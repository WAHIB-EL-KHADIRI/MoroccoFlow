import { randomUUID } from "node:crypto";
import { createOpaqueToken, hashToken, normalizeEmail } from "../../lib/crypto.js";
import { AppError, conflict } from "../../lib/errors.js";
import { toPublicJson } from "../../lib/serialize.js";
import { respondAfterCommit } from "../../lib/crud.js";

const allowedRoles = ["admin", "sales", "project_manager", "finance", "hr", "viewer"];

export async function teamRoutes(app) {
  app.get(
    "/team",
    { preHandler: app.requirePermission("team:read"), schema: { tags: ["Team"] } },
    async (request) =>
      app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          `SELECT id, email, full_name, role, department, status, last_login_at,
                  created_at, updated_at, version
           FROM users ORDER BY full_name ASC`,
        );
        return { data: toPublicJson(result.rows) };
      }),
  );

  app.post(
    "/team/invitations",
    {
      preHandler: app.requirePermission("team:write"),
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["Team"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "fullName", "role"],
          properties: {
            email: { type: "string", format: "email", maxLength: 254 },
            fullName: { type: "string", minLength: 2, maxLength: 160 },
            role: { type: "string", enum: allowedRoles },
          },
        },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const id = randomUUID();
        const token = createOpaqueToken();
        const email = normalizeEmail(request.body.email);
        const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
        if (existing.rowCount) throw conflict("A member with this email already exists");
        await client.query(
          "UPDATE user_invitations SET accepted_at = now() WHERE email = $1 AND accepted_at IS NULL",
          [email],
        );
        const result = await client.query(
          `INSERT INTO user_invitations
             (id, tenant_id, email, full_name, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '72 hours')
           RETURNING id, email, full_name, role, expires_at, created_at`,
          [
            id,
            request.auth.tenantId,
            email,
            request.body.fullName,
            request.body.role,
            hashToken(token),
            request.auth.userId,
          ],
        );
        await app.writeAudit(client, request.auth, {
          action: "invitation.created",
          entityType: "invitation",
          entityId: id,
          after: result.rows[0],
          request,
        });
        return {
          statusCode: 201,
          body: { data: { ...toPublicJson(result.rows[0]), invitationToken: token } },
        };
      }),
  );

  app.patch(
    "/team/:id",
    {
      preHandler: app.requirePermission("team:write"),
      schema: {
        tags: ["Team"],
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["version"],
          additionalProperties: false,
          properties: {
            version: { type: "integer", minimum: 1 },
            role: { type: "string", enum: allowedRoles },
            department: { anyOf: [{ type: "string", maxLength: 100 }, { type: "null" }] },
            status: { type: "string", enum: ["active", "archived"] },
          },
        },
      },
    },
    async (request) => {
      if (
        request.params.id === request.auth.userId &&
        (request.body.status === "archived" || request.body.role)
      ) {
        throw new AppError(
          "SELF_ACCESS_CHANGE",
          "You cannot change your own role or deactivate your own account",
          409,
        );
      }
      return app.withTenant(request.auth, async (client) => {
        const entries = Object.entries(request.body).filter(([key]) => key !== "version");
        if (!entries.length) throw new AppError("EMPTY_UPDATE", "No fields to update", 400);
        const map = { role: "role", department: "department", status: "status" };
        const values = entries.map(([, value]) => value);
        const sets = entries.map(([key], index) => `${map[key]} = $${index + 1}`);
        values.push(request.params.id, request.body.version);
        const result = await client.query(
          `UPDATE users SET ${sets.join(", ")}
           WHERE id = $${values.length - 1} AND version = $${values.length}
           RETURNING id, email, full_name, role, department, status, updated_at, version`,
          values,
        );
        if (!result.rowCount) throw conflict("Member not found or changed by another user");
        await client.query(
          "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
          [request.params.id],
        );
        await app.writeAudit(client, request.auth, {
          action: "user.updated",
          entityType: "user",
          entityId: request.params.id,
          after: result.rows[0],
          request,
        });
        return { data: toPublicJson(result.rows[0]) };
      });
    },
  );
}
