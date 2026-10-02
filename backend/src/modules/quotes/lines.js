import { randomUUID } from "node:crypto";
import { AppError, notFound } from "../../lib/errors.js";
import { computeTotals, lineSubtotalCents } from "../../lib/vat.js";

/**
 * Replaces every line of a draft quote and recomputes its subtotal and VAT from them,
 * in the caller's transaction. The quote row is locked first, so two concurrent
 * replacements serialise and the totals always match the stored lines.
 *
 * Only draft quotes are editable here: once a quote is sent, its lines are what the
 * client saw and agreed to.
 *
 * `client` must run under the tenant's RLS context; the quote lookup is what proves
 * the quote belongs to the caller's company.
 */
export async function replaceQuoteLines(client, auth, quoteId, lines, audit) {
  const found = await client.query(
    "SELECT id, status FROM quotes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    [quoteId],
  );
  if (!found.rowCount) throw notFound("Quote");
  if (found.rows[0].status !== "draft") {
    throw new AppError(
      "QUOTE_NOT_DRAFT",
      `Lines can only be changed on a draft quote, not a ${found.rows[0].status} one`,
      409,
    );
  }

  const totals = computeTotals(lines);

  await client.query("DELETE FROM line_items WHERE quote_id = $1", [quoteId]);
  for (const [position, line] of lines.entries()) {
    await client.query(
      `INSERT INTO line_items
         (id, tenant_id, quote_id, description, quantity, unit_price_cents,
          tax_rate_basis_points, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        auth.tenantId,
        quoteId,
        line.description,
        line.quantity,
        line.unitPriceCents,
        line.taxRateBasisPoints ?? 0,
        position,
      ],
    );
  }
  const updated = await client.query(
    `UPDATE quotes
     SET subtotal_cents = $2, tax_cents = $3, version = version + 1, updated_at = now()
     WHERE id = $1
     RETURNING id, subtotal_cents, tax_cents, total_cents, version`,
    [quoteId, totals.subtotalCents, totals.taxCents],
  );

  await audit({
    action: "quote.lines_replaced",
    entityType: "quote",
    entityId: quoteId,
    after: {
      lineCount: lines.length,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
    },
  });

  return {
    quote: updated.rows[0],
    lines: lines.map((line, position) => ({
      position,
      description: line.description,
      quantity: String(line.quantity),
      unitPriceCents: line.unitPriceCents,
      taxRateBasisPoints: line.taxRateBasisPoints ?? 0,
      subtotalCents: Number(lineSubtotalCents(line)),
    })),
    vat: totals.byRate,
  };
}

/** Lines of a quote with their VAT breakdown, for the detail view. */
export async function quoteLines(client, quoteId) {
  const result = await client.query(
    `SELECT id, description, quantity, unit_price_cents, tax_rate_basis_points, position
     FROM line_items WHERE quote_id = $1 ORDER BY position`,
    [quoteId],
  );

  return result.rows;
}
