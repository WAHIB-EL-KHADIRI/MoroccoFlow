/**
 * A deliberately small stand-in for the PostgreSQL client the route handlers
 * are given by `databasePlugin.withTenant`.
 *
 * It exists so the *server-side* idempotency gate and the audit trail can be
 * exercised through the real routes on a machine with no database, and in CI
 * before the container is up. It is not a SQL engine: it recognises exactly the
 * statements `crud.js`, `idempotency.js` and `audit.js` issue, and throws on
 * anything else, so a query the application starts sending that this file does
 * not know about fails the suite loudly instead of silently returning no rows.
 *
 * The behaviours it copies from PostgreSQL, because tests depend on them:
 *   - `ON CONFLICT DO NOTHING RETURNING key` returns zero rows on a collision;
 *   - a duplicate primary key raises SQLSTATE 23505;
 *   - a value longer than a varchar(n) column raises SQLSTATE 22001;
 *   - `BEFORE UPDATE` triggers bump `version` and `updated_at`;
 *   - row-level security confines every statement to the session tenant;
 *   - a failed transaction rolls back every write it made;
 *   - `jsonb` returns parsed objects, not the JSON text that was inserted.
 *
 * Time is a counter, not the wall clock: every timestamp is derived from
 * `BASE_TIME` and advances only when a test says so.
 */
import { createHash } from "node:crypto";

/** Fixed origin for every generated timestamp. */
export const BASE_TIME = Date.UTC(2026, 2, 1, 9, 0, 0);

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Column width limits that can realistically be overrun by request data. */
const VARCHAR_LIMITS = { action: 80, entity_type: 80, user_agent: 300 };

function databaseError(message, code) {
  return Object.assign(new Error(message), { code });
}

function result(rows) {
  return { rows, rowCount: rows.length };
}

function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** `$3` -> the third element of the parameter array. */
function placeholderIndexes(list) {
  return list.split(",").map((token) => Number(token.trim().slice(1)) - 1);
}

function unquote(token) {
  return token.trim().replace(/^"|"$/g, "");
}

export class FakeDatabase {
  constructor() {
    this.reset();
  }

  reset() {
    /** table name -> (id -> row) */
    this.tables = new Map();
    /** `tenant|key` -> idempotency row */
    this.idempotency = new Map();
    this.audit = [];
    /** Normalised SQL of every statement executed, in order. */
    this.log = [];
    this.clockMs = BASE_TIME;
    this.tick = 0;
    this.tenant = null;
  }

  /** Move the fake clock forward; the only way time passes here. */
  advanceHours(hours) {
    this.clockMs += hours * 60 * 60 * 1000;
  }

  now() {
    return this.clockMs + this.tick;
  }

  timestamp() {
    // One millisecond per statement keeps `updated_at` strictly increasing
    // without ever reading the host clock.
    this.tick += 1;
    return new Date(this.now()).toISOString();
  }

  rowsOf(table) {
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    return this.tables.get(table);
  }

  /** Rows of `table` visible to the session tenant, as row-level security would. */
  visibleRows(table) {
    return [...this.rowsOf(table).values()].filter((row) => row.tenant_id === this.tenant);
  }

  seed(table, row) {
    const stored = {
      version: 1,
      created_at: new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
      deleted_at: null,
      ...row,
    };
    this.rowsOf(table).set(stored.id, stored);
    return stored;
  }

  /** Reserve a key without completing it, the state a concurrent request leaves. */
  reserveKey(tenantId, key, requestHash) {
    this.idempotency.set(`${tenantId}|${key}`, {
      request_hash: requestHash,
      response_status: null,
      response_body: null,
      expires_at: this.now() + IDEMPOTENCY_TTL_MS,
    });
  }

  snapshot() {
    return {
      tables: new Map(
        [...this.tables].map(([name, rows]) => [
          name,
          new Map([...rows].map(([id, row]) => [id, { ...row }])),
        ]),
      ),
      idempotency: new Map([...this.idempotency].map(([key, row]) => [key, { ...row }])),
      audit: this.audit.slice(),
    };
  }

  restore(snapshot) {
    this.tables = snapshot.tables;
    this.idempotency = snapshot.idempotency;
    this.audit = snapshot.audit;
  }

  /**
   * Mirrors `databasePlugin.transaction`: a handler that throws must leave no
   * trace, including the idempotency reservation it may already have written.
   */
  async transaction(auth, operation) {
    const before = this.snapshot();
    const previousTenant = this.tenant;
    this.tenant = auth?.tenantId ?? null;
    try {
      return await operation(this);
    } catch (error) {
      this.restore(before);
      throw error;
    } finally {
      this.tenant = previousTenant;
    }
  }

  async query(text, params = []) {
    const sql = normalise(text);
    this.log.push(sql);

    const idempotencyResult = this.idempotencyQuery(sql, params);
    if (idempotencyResult) return idempotencyResult;
    if (sql.startsWith("INSERT INTO audit_logs")) return this.insertAudit(params);
    return this.rowQuery(sql, params);
  }

  idempotencyQuery(sql, params) {
    if (sql.startsWith("DELETE FROM idempotency_keys")) {
      const id = `${params[0]}|${params[1]}`;
      const row = this.idempotency.get(id);
      if (row && row.expires_at < this.now()) {
        this.idempotency.delete(id);
        return result([{}]);
      }
      return result([]);
    }

    if (sql.startsWith("INSERT INTO idempotency_keys")) {
      const [tenantId, key, hash] = params;
      const id = `${tenantId}|${key}`;
      // ON CONFLICT DO NOTHING: an existing key yields no row, and the caller
      // reads it back instead of overwriting it.
      if (this.idempotency.has(id)) return result([]);
      this.reserveKey(tenantId, key, hash);
      return result([{ key }]);
    }

    if (sql.startsWith("SELECT request_hash, response_status, response_body")) {
      const row = this.idempotency.get(`${params[0]}|${params[1]}`);
      return result(row ? [{ ...row }] : []);
    }

    if (sql.startsWith("UPDATE idempotency_keys SET response_status")) {
      const [tenantId, key, status, body] = params;
      const row = this.idempotency.get(`${tenantId}|${key}`);
      if (!row) return result([]);
      row.response_status = status;
      // jsonb hands back a parsed value, never the text that was written.
      row.response_body = body === null ? null : JSON.parse(body);
      return result([{}]);
    }

    return null;
  }

  insertAudit(params) {
    const [tenantId, actorUserId, action, entityType, entityId, before, after, ip, userAgent] =
      params;
    const record = {
      tenant_id: tenantId,
      actor_user_id: actorUserId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      before_data: before === null ? null : JSON.parse(before),
      after_data: after === null ? null : JSON.parse(after),
      // The column is written through `encode(digest(...), 'hex')`; the raw
      // address never reaches storage, so the fake hashes it too.
      ip_hash: createHash("sha256")
        .update(ip ?? "", "utf8")
        .digest("hex"),
      user_agent: userAgent ?? null,
    };
    for (const [column, limit] of Object.entries(VARCHAR_LIMITS)) {
      if (typeof record[column] === "string" && record[column].length > limit) {
        throw databaseError(`value too long for type character varying(${limit})`, "22001");
      }
    }
    this.audit.push(record);
    return result([{}]);
  }

  rowQuery(sql, params) {
    const insert = sql.match(/^INSERT INTO "(\w+)" \(([^)]+)\) VALUES \(([^)]+)\) RETURNING \*$/);
    if (insert) {
      const [, table, columnList, valueList] = insert;
      const columns = columnList.split(",").map(unquote);
      const indexes = placeholderIndexes(valueList);
      const row = Object.fromEntries(columns.map((column, at) => [column, params[indexes[at]]]));
      if (this.rowsOf(table).has(row.id)) {
        throw databaseError(
          `duplicate key value violates unique constraint "${table}_pkey"`,
          "23505",
        );
      }
      if (row.tenant_id !== this.tenant) {
        throw databaseError("new row violates row-level security policy", "42501");
      }
      return result([this.seed(table, row)]);
    }

    const selectOne = sql.match(/^SELECT \* FROM "(\w+)" WHERE id = \$1 AND deleted_at IS NULL$/);
    if (selectOne) {
      const row = this.visibleRows(selectOne[1]).find(
        (candidate) => candidate.id === params[0] && candidate.deleted_at === null,
      );
      return result(row ? [{ ...row }] : []);
    }

    const exists = sql.match(/^SELECT id FROM "(\w+)" WHERE id = \$1$/);
    if (exists) {
      const row = this.visibleRows(exists[1]).find((candidate) => candidate.id === params[0]);
      return result(row ? [{ id: row.id }] : []);
    }

    const softDelete = sql.match(
      /^UPDATE "(\w+)" SET deleted_at = now\(\) WHERE id = \$1 AND version = \$2 AND deleted_at IS NULL RETURNING \*$/,
    );
    if (softDelete) {
      return this.mutateRow(softDelete[1], params[0], params[1], (row) => {
        row.deleted_at = this.timestamp();
      });
    }

    const update = sql.match(
      /^UPDATE "(\w+)" SET (.+) WHERE id = \$(\d+) AND version = \$(\d+) AND deleted_at IS NULL RETURNING \*$/,
    );
    if (update) {
      const [, table, assignments, idIndex, versionIndex] = update;
      const changes = [...assignments.matchAll(/"?(\w+)"? = \$(\d+)/g)];
      return this.mutateRow(table, params[idIndex - 1], params[versionIndex - 1], (row) => {
        for (const [, column, placeholder] of changes) row[column] = params[placeholder - 1];
      });
    }

    throw new Error(`FakeDatabase received an unexpected query: ${sql}`);
  }

  /** Applies the optimistic-locking guard and the updated-at trigger. */
  mutateRow(table, id, version, apply) {
    const row = this.visibleRows(table).find(
      (candidate) =>
        candidate.id === id && candidate.version === version && candidate.deleted_at === null,
    );
    if (!row) return result([]);
    apply(row);
    row.version += 1;
    row.updated_at = this.timestamp();
    return result([{ ...row }]);
  }
}
