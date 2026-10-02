import { AppError, notFound } from "../../lib/errors.js";
import { effectiveQuoteStatus, isOpen } from "./lifecycle.js";
import { quoteLines } from "./lines.js";

/**
 * Accepts a quote: marks it accepted, opens its project and records what the client
 * now owes, in the caller's transaction. Any failure rolls all three back.
 *
 * Accepting an already-accepted quote is not an error: it returns the project and
 * obligation created the first time, with `replayed: true`. The quote row is locked
 * first, so two concurrent acceptances serialise and the second one sees "accepted";
 * the unique keys on projects.quote_id and payment_obligations.quote_id are the
 * backstop if that ever stopped being true.
 *
 * `client` must run under the tenant's RLS context: the quote lookup is what proves
 * the quote belongs to the caller's company. Nothing here trusts a tenant id from input.
 */
export async function acceptQuote(client, auth, input, audit) {
  const found = await client.query(
    `SELECT q.*, (q.valid_until IS NOT NULL
                  AND q.valid_until < (now() AT TIME ZONE t.timezone)::date) AS expired
     FROM quotes q JOIN tenants t ON t.id = q.tenant_id
     WHERE q.id = $1 AND q.deleted_at IS NULL
     FOR UPDATE OF q`,
    [input.quoteId],
  );
  if (!found.rowCount) throw notFound("Quote");
  const quote = found.rows[0];

  if (quote.status === "accepted") {
    const [project, obligation] = await Promise.all([
      client.query("SELECT * FROM projects WHERE quote_id = $1", [quote.id]),
      client.query("SELECT * FROM payment_obligations WHERE quote_id = $1", [quote.id]),
    ]);
    return {
      replayed: true,
      quote: withoutDerived(quote),
      project: project.rows[0] ?? null,
      obligation: obligation.rows[0] ?? null,
    };
  }
  if (!isOpen(quote.status)) {
    throw new AppError("QUOTE_NOT_ACCEPTABLE", `A ${quote.status} quote cannot be accepted`, 409);
  }
  if (quote.expired) {
    throw new AppError("QUOTE_EXPIRED", "The quote is past its validity date", 409);
  }
  if (BigInt(quote.total_cents) <= 0n) {
    throw new AppError("QUOTE_EMPTY", "A quote with a zero total cannot be accepted", 422);
  }

  const accepted = await client.query(
    `UPDATE quotes SET status = 'accepted', accepted_at = now(), accepted_by = $2
     WHERE id = $1 RETURNING *`,
    [quote.id, auth.userId],
  );
  const project = await client.query(
    `INSERT INTO projects (tenant_id, client_id, quote_id, name, status, owner_user_id)
     VALUES ($1, $2, $3, $4, 'active', $5) RETURNING *`,
    [auth.tenantId, quote.client_id, quote.id, input.projectName || quote.number, auth.userId],
  );
  const obligation = await client.query(
    `INSERT INTO payment_obligations
       (tenant_id, client_id, quote_id, project_id, amount_cents, currency, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      auth.tenantId,
      quote.client_id,
      quote.id,
      project.rows[0].id,
      quote.total_cents,
      quote.currency,
      input.dueDate,
      auth.userId,
    ],
  );

  await audit({
    action: "quote.accepted",
    entityType: "quote",
    entityId: quote.id,
    before: withoutDerived(quote),
    after: accepted.rows[0],
  });
  await audit({
    action: "project.created",
    entityType: "project",
    entityId: project.rows[0].id,
    after: project.rows[0],
  });
  await audit({
    action: "payment_obligation.created",
    entityType: "payment_obligation",
    entityId: obligation.rows[0].id,
    after: obligation.rows[0],
  });

  return {
    replayed: false,
    quote: accepted.rows[0],
    project: project.rows[0],
    obligation: obligation.rows[0],
  };
}

/** One quote with what it led to, for the detail view. */
export async function quoteDetail(client, quoteId, { includeFinance }) {
  const found = await client.query(
    `SELECT q.*, (q.valid_until IS NOT NULL
                  AND q.valid_until < (now() AT TIME ZONE t.timezone)::date) AS expired
     FROM quotes q JOIN tenants t ON t.id = q.tenant_id
     WHERE q.id = $1 AND q.deleted_at IS NULL`,
    [quoteId],
  );
  if (!found.rowCount) throw notFound("Quote");
  const quote = found.rows[0];
  const [project, obligation, history] = await Promise.all([
    client.query(
      "SELECT id, name, status FROM projects WHERE quote_id = $1 AND deleted_at IS NULL",
      [quoteId],
    ),
    includeFinance
      ? client.query("SELECT * FROM payment_obligation_balances WHERE quote_id = $1", [quoteId])
      : { rows: [] },
    // Who did what to this quote, without the before/after payloads.
    client.query(
      `SELECT a.action, a.created_at, u.full_name AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.entity_type = 'quote' AND a.entity_id = $1
       ORDER BY a.created_at, a.id`,
      [quoteId],
    ),
  ]);
  return {
    ...withoutDerived(quote),
    effectiveStatus: effectiveQuoteStatus(quote.status, quote.expired),
    lines: await quoteLines(client, quoteId),
    project: project.rows[0] ?? null,
    obligation: obligation.rows[0] ?? null,
    history: history.rows,
  };
}

function withoutDerived(row) {
  const stored = { ...row };
  delete stored.expired;
  return stored;
}
