import { createHash } from "node:crypto";
import { AppError } from "./errors.js";

function requestHash(request) {
  return createHash("sha256")
    .update(`${request.method}\n${request.url}\n${JSON.stringify(request.body ?? null)}`, "utf8")
    .digest("hex");
}

export async function beginIdempotency(client, auth, request) {
  const key = request.headers["idempotency-key"];
  if (!key) return null;
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,120}$/.test(key)) {
    throw new AppError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is invalid", 400);
  }
  const hash = requestHash(request);
  await client.query(
    "DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 AND expires_at < now()",
    [auth.tenantId, key],
  );
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (tenant_id, key, request_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '24 hours')
     ON CONFLICT DO NOTHING RETURNING key`,
    [auth.tenantId, key, hash],
  );
  if (inserted.rowCount) return { key, hash, cached: null };

  const existing = await client.query(
    `SELECT request_hash, response_status, response_body
     FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 FOR UPDATE`,
    [auth.tenantId, key],
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== hash) {
    throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was used for another request", 409);
  }
  if (row.response_status === null) {
    throw new AppError("REQUEST_IN_PROGRESS", "An identical request is still in progress", 409);
  }
  return {
    key,
    hash,
    cached: { statusCode: row.response_status, body: row.response_body },
  };
}

export async function completeIdempotency(client, auth, gate, statusCode, body) {
  if (!gate) return;
  await client.query(
    `UPDATE idempotency_keys SET response_status = $3, response_body = $4
     WHERE tenant_id = $1 AND key = $2`,
    [auth.tenantId, gate.key, statusCode, body === undefined ? null : JSON.stringify(body)],
  );
}
