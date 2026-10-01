import { randomUUID } from "node:crypto";
import { AppError, conflict, notFound } from "./errors.js";
import { decodeCursor, encodeCursor, toPublicJson } from "./serialize.js";
import { errorResponse, paginationQuery, uuid } from "./schemas.js";
import { beginIdempotency, completeIdempotency } from "./idempotency.js";

const identifier = /^[a-z_][a-z0-9_]*$/;

function safeIdentifier(value) {
  if (!identifier.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function buildColumns(fieldMap) {
  return Object.fromEntries(
    Object.entries(fieldMap).map(([publicName, column]) => [publicName, safeIdentifier(column)]),
  );
}

/**
 * Runs `operation` in the tenant transaction and sends its `{ statusCode, body }`
 * only once COMMIT has returned. Replying from inside the transaction told the
 * client "created" before the row was visible to its next request, and before a
 * failing COMMIT could turn that success into a lie.
 */
export async function respondAfterCommit(app, request, reply, operation, auth = request.auth) {
  const { statusCode, body } = await app.withTenant(auth, operation);
  return reply.code(statusCode).send(body ?? undefined);
}

export function registerCrudRoutes(app, config) {
  const {
    path,
    table,
    entity,
    permission,
    fieldMap,
    required = [],
    properties,
    searchColumns = [],
    defaults = {},
    // Optional domain rules: a narrower body for creation, and guards that see the
    // stored row before an update or delete and throw to refuse it.
    createProperties = properties,
    guardUpdate,
    guardDelete,
  } = config;
  const tableName = safeIdentifier(table);
  const columns = buildColumns(fieldMap);
  const allowedFields = Object.keys(columns);

  app.get(
    path,
    {
      preHandler: app.requirePermission(`${permission}:read`),
      schema: {
        tags: [entity],
        querystring: paginationQuery,
        response: { 400: errorResponse, 401: errorResponse, 403: errorResponse },
      },
    },
    async (request) => {
      const limit = request.query.limit || 30;
      const cursor = decodeCursor(request.query.cursor);
      if (request.query.cursor && !cursor) {
        throw new AppError("INVALID_CURSOR", "The pagination cursor is invalid", 400);
      }

      return app.withTenant(request.auth, async (client) => {
        const values = [];
        const conditions = ["deleted_at IS NULL"];
        if (request.query.q && searchColumns.length) {
          values.push(`%${request.query.q}%`);
          const search = searchColumns
            .map((column) => `${safeIdentifier(column)}::text ILIKE $${values.length}`)
            .join(" OR ");
          conditions.push(`(${search})`);
        }
        if (cursor) {
          values.push(cursor.updatedAt, cursor.id);
          conditions.push(
            `(updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
          );
        }
        values.push(limit + 1);
        const result = await client.query(
          `SELECT * FROM ${tableName}
           WHERE ${conditions.join(" AND ")}
           ORDER BY updated_at DESC, id DESC
           LIMIT $${values.length}`,
          values,
        );
        const hasMore = result.rows.length > limit;
        const rows = result.rows.slice(0, limit);
        return {
          data: toPublicJson(rows),
          page: { hasMore, nextCursor: hasMore ? encodeCursor(rows.at(-1)) : null },
        };
      });
    },
  );

  app.post(
    path,
    {
      preHandler: app.requirePermission(`${permission}:write`),
      schema: {
        tags: [entity],
        body: {
          type: "object",
          additionalProperties: false,
          required,
          properties: { id: uuid, ...createProperties },
        },
        response: { 400: errorResponse, 401: errorResponse, 403: errorResponse },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const gate = await beginIdempotency(client, request.auth, request);
        if (gate?.cached) return gate.cached;
        const id = request.body.id || randomUUID();
        const input = { ...defaults, ...request.body };
        const provided = allowedFields.filter((field) => input[field] !== undefined);
        const sqlColumns = ["id", "tenant_id", ...provided.map((field) => columns[field])];
        const values = [id, request.auth.tenantId, ...provided.map((field) => input[field])];
        const placeholders = values.map((_, index) => `$${index + 1}`);
        const result = await client.query(
          `INSERT INTO ${tableName} (${sqlColumns.join(", ")})
           VALUES (${placeholders.join(", ")}) RETURNING *`,
          values,
        );
        await app.writeAudit(client, request.auth, {
          action: `${entity}.created`,
          entityType: entity,
          entityId: id,
          after: result.rows[0],
          request,
        });
        const payload = { data: toPublicJson(result.rows[0]) };
        await completeIdempotency(client, request.auth, gate, 201, payload);
        return { statusCode: 201, body: payload };
      }),
  );

  app.patch(
    `${path}/:id`,
    {
      preHandler: app.requirePermission(`${permission}:write`),
      schema: {
        tags: [entity],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["version"],
          minProperties: 2,
          properties: { version: { type: "integer", minimum: 1 }, ...properties },
        },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const gate = await beginIdempotency(client, request.auth, request);
        if (gate?.cached) return gate.cached;
        const provided = allowedFields.filter((field) => request.body[field] !== undefined);
        if (!provided.length) throw new AppError("EMPTY_UPDATE", "No fields to update", 400);
        const before = await client.query(
          `SELECT * FROM ${tableName} WHERE id = $1 AND deleted_at IS NULL`,
          [request.params.id],
        );
        if (!before.rowCount) throw notFound(entity);
        guardUpdate?.(before.rows[0], request.body);

        const values = provided.map((field) => request.body[field]);
        const assignments = provided.map((field, index) => `${columns[field]} = $${index + 1}`);
        values.push(request.params.id, request.body.version);
        const result = await client.query(
          `UPDATE ${tableName} SET ${assignments.join(", ")}
           WHERE id = $${values.length - 1} AND version = $${values.length}
             AND deleted_at IS NULL RETURNING *`,
          values,
        );
        if (!result.rowCount) throw conflict();
        await app.writeAudit(client, request.auth, {
          action: `${entity}.updated`,
          entityType: entity,
          entityId: request.params.id,
          before: before.rows[0],
          after: result.rows[0],
          request,
        });
        const payload = { data: toPublicJson(result.rows[0]) };
        await completeIdempotency(client, request.auth, gate, 200, payload);
        return { statusCode: 200, body: payload };
      }),
  );

  app.delete(
    `${path}/:id`,
    {
      preHandler: app.requirePermission(`${permission}:write`),
      schema: {
        tags: [entity],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: uuid },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["version"],
          properties: { version: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const gate = await beginIdempotency(client, request.auth, request);
        if (gate?.cached) return gate.cached;
        if (guardDelete) {
          const stored = await client.query(
            `SELECT * FROM ${tableName} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
            [request.params.id],
          );
          if (stored.rowCount) guardDelete(stored.rows[0]);
        }
        const result = await client.query(
          `UPDATE ${tableName} SET deleted_at = now()
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING *`,
          [request.params.id, request.query.version],
        );
        if (!result.rowCount) {
          const exists = await client.query(`SELECT id FROM ${tableName} WHERE id = $1`, [
            request.params.id,
          ]);
          if (!exists.rowCount) throw notFound(entity);
          throw conflict();
        }
        await app.writeAudit(client, request.auth, {
          action: `${entity}.deleted`,
          entityType: entity,
          entityId: request.params.id,
          before: result.rows[0],
          request,
        });
        await completeIdempotency(client, request.auth, gate, 204, null);
        return { statusCode: 204 };
      }),
  );
}
