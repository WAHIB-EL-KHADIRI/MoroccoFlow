import { AppError, notFound } from "../../lib/errors.js";

export const PAYMENT_STATUSES = ["unpaid", "partial", "paid", "overdue"];
export const PAYMENT_METHODS = ["transfer", "cash", "cheque", "card", "other"];

/**
 * Records money received against an obligation. The obligation row is locked
 * first, so two concurrent payments cannot both fit in the same remaining balance:
 * the total paid can never exceed what is owed.
 */
export async function recordPayment(client, auth, input, audit) {
  const locked = await client.query(
    "SELECT id FROM payment_obligations WHERE id = $1 FOR UPDATE",
    [input.obligationId],
  );
  if (!locked.rowCount) throw notFound("Payment obligation");

  const before = await balance(client, input.obligationId);
  if (BigInt(input.amountCents) > BigInt(before.remaining_cents)) {
    throw new AppError(
      "OVERPAYMENT",
      "The payment is larger than the remaining balance",
      409,
      { remainingCents: Number(before.remaining_cents) },
    );
  }

  const payment = await client.query(
    `INSERT INTO payments
       (tenant_id, obligation_id, amount_cents, paid_on, method, reference, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      auth.tenantId,
      input.obligationId,
      input.amountCents,
      input.paidOn,
      input.method || "transfer",
      input.reference || null,
      auth.userId,
    ],
  );
  const after = await balance(client, input.obligationId);
  await audit({
    action: "payment.recorded",
    entityType: "payment_obligation",
    entityId: input.obligationId,
    before,
    after: { ...after, payment: payment.rows[0] },
  });
  return { payment: payment.rows[0], obligation: after };
}

export async function balance(client, obligationId) {
  const result = await client.query("SELECT * FROM payment_obligation_balances WHERE id = $1", [
    obligationId,
  ]);
  if (!result.rowCount) throw notFound("Payment obligation");
  return result.rows[0];
}

export async function listObligations(client, { status, limit }) {
  const values = [];
  const conditions = [];
  if (status) {
    values.push(status);
    conditions.push(`payment_status = $${values.length}`);
  }
  values.push(limit);
  const result = await client.query(
    `SELECT * FROM payment_obligation_balances
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY due_date, id
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function obligationWithPayments(client, obligationId) {
  const obligation = await balance(client, obligationId);
  const payments = await client.query(
    "SELECT * FROM payments WHERE obligation_id = $1 ORDER BY paid_on, created_at",
    [obligationId],
  );
  return { ...obligation, payments: payments.rows };
}
