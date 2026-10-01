import { AppError, notFound } from "../../lib/errors.js";
import { toPublicJson } from "../../lib/serialize.js";
import { respondAfterCommit } from "../../lib/crud.js";

export async function insightRoutes(app) {
  app.get(
    "/dashboard",
    { preHandler: app.requirePermission("reports:read"), schema: { tags: ["Reports"] } },
    async (request) =>
      app.withTenant(request.auth, async (client) => {
        const [counts, finance, tasks, monthly] = await Promise.all([
          client.query(`SELECT
            (SELECT count(*) FROM clients WHERE deleted_at IS NULL) AS clients,
            (SELECT count(*) FROM projects WHERE deleted_at IS NULL AND status = 'active') AS active_projects,
            (SELECT count(*) FROM users WHERE status = 'active') AS team_members`),
          client.query(`SELECT
            COALESCE(sum(total_cents) FILTER (WHERE status = 'paid'), 0) AS revenue_cents,
            COALESCE(sum(total_cents - paid_cents)
              FILTER (WHERE status NOT IN ('paid', 'cancelled')), 0) AS outstanding_cents,
            COALESCE((SELECT sum(amount_cents) FROM expenses WHERE deleted_at IS NULL), 0) AS expenses_cents
            FROM invoices WHERE deleted_at IS NULL`),
          client.query(`SELECT status, count(*) AS count FROM tasks
            WHERE deleted_at IS NULL GROUP BY status ORDER BY status`),
          client.query(`WITH months AS (
              SELECT generate_series(date_trunc('month', now()) - interval '5 months',
                                     date_trunc('month', now()), interval '1 month') AS month
            )
            SELECT to_char(months.month, 'YYYY-MM') AS month,
                   COALESCE((SELECT sum(i.total_cents) FROM invoices i
                     WHERE i.status = 'paid' AND i.deleted_at IS NULL
                       AND date_trunc('month', i.issue_date) = months.month), 0) AS revenue_cents,
                   COALESCE((SELECT sum(e.amount_cents) FROM expenses e
                     WHERE e.deleted_at IS NULL
                       AND date_trunc('month', e.expense_date) = months.month), 0) AS expenses_cents
            FROM months ORDER BY months.month`),
        ]);
        return {
          data: toPublicJson({
            ...counts.rows[0],
            ...finance.rows[0],
            tasks: tasks.rows,
            monthly: monthly.rows,
          }),
        };
      }),
  );

  app.get(
    "/notifications",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["Notifications"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 30 } },
        },
      },
    },
    async (request) =>
      app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          `SELECT id, type, title, detail, read_at, created_at
           FROM notifications
           WHERE user_id IS NULL OR user_id = $1
           ORDER BY created_at DESC LIMIT $2`,
          [request.auth.userId, request.query.limit || 30],
        );
        return { data: toPublicJson(result.rows) };
      }),
  );

  app.patch(
    "/notifications/:id/read",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["Notifications"],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request) =>
      app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          `UPDATE notifications SET read_at = COALESCE(read_at, now())
           WHERE id = $1 AND (user_id IS NULL OR user_id = $2)
           RETURNING id, read_at`,
          [request.params.id, request.auth.userId],
        );
        if (!result.rowCount) throw notFound("Notification");
        return { data: toPublicJson(result.rows[0]) };
      }),
  );

  app.get(
    "/audit-log",
    {
      preHandler: app.requirePermission("settings:read"),
      schema: {
        tags: ["Audit"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        },
      },
    },
    async (request) =>
      app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          `SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at,
                  u.full_name AS actor_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
           ORDER BY a.created_at DESC LIMIT $1`,
          [request.query.limit || 50],
        );
        return { data: toPublicJson(result.rows) };
      }),
  );

  app.get(
    "/exports/finance.csv",
    { preHandler: app.requirePermission("finance:read"), schema: { tags: ["Exports"] } },
    async (request, reply) =>
      app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          `SELECT number, issue_date, due_date, status, total_cents, paid_cents, currency
           FROM invoices WHERE deleted_at IS NULL ORDER BY issue_date DESC`,
        );
        const escape = (value) => {
          const safe = /^[=+\-@\t\r]/.test(String(value)) ? `'${value}` : String(value ?? "");
          return `"${safe.replaceAll('"', '""')}"`;
        };
        const header = [
          "number",
          "issue_date",
          "due_date",
          "status",
          "total_cents",
          "paid_cents",
          "currency",
        ];
        const lines = [
          header.join(","),
          ...result.rows.map((row) => header.map((key) => escape(row[key])).join(",")),
        ];
        reply.header("content-type", "text/csv; charset=utf-8");
        reply.header("content-disposition", "attachment; filename=moroccoflow-finance.csv");
        return `\uFEFF${lines.join("\r\n")}`;
      }),
  );

  app.post(
    "/notifications",
    {
      preHandler: app.requirePermission("team:write"),
      schema: {
        hide: true,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title"],
          properties: {
            userId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            type: { type: "string", enum: ["info", "success", "warning", "error"] },
            title: { type: "string", minLength: 1, maxLength: 240 },
            detail: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] },
          },
        },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const result = await client.query(
          `INSERT INTO notifications (tenant_id, user_id, type, title, detail)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            request.auth.tenantId,
            request.body.userId || null,
            request.body.type,
            request.body.title,
            request.body.detail || null,
          ],
        );
        if (!result.rowCount)
          throw new AppError("CREATE_FAILED", "Notification was not created", 500);
        return { statusCode: 201, body: { data: toPublicJson(result.rows[0]) } };
      }),
  );
}
