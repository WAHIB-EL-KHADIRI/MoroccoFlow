import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

suite("PostgreSQL tenant isolation", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const clientId = randomUUID();

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Tenant A'), ($3, $4, 'Tenant B')`,
      [tenantA, `tenant-a-${tenantA.slice(0, 8)}`, tenantB, `tenant-b-${tenantB.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'test-hash', 'Owner A', 'owner'),
              ($4, $5, $6, 'test-hash', 'Owner B', 'owner')`,
      [
        userA,
        tenantA,
        `owner-${userA}@example.test`,
        userB,
        tenantB,
        `owner-${userB}@example.test`,
      ],
    );
  });

  afterAll(async () => {
    try {
      await pool.query("DELETE FROM audit_logs WHERE tenant_id IN ($1, $2)", [tenantA, tenantB]);
      await pool.query("DELETE FROM tenants WHERE id IN ($1, $2)", [tenantA, tenantB]);
    } finally {
      await pool.end();
    }
  });

  async function tenantTransaction(tenantId, userId, operation) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE moroccoflow_app");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("prevents one company from reading another company's records", async () => {
    await tenantTransaction(tenantA, userA, (client) =>
      client.query(
        `INSERT INTO clients (id, tenant_id, name, company, created_by)
         VALUES ($1, $2, 'Contact A', 'Company A', $3)`,
        [clientId, tenantA, userA],
      ),
    );
    const visibleToA = await tenantTransaction(tenantA, userA, (client) =>
      client.query("SELECT id FROM clients WHERE id = $1", [clientId]),
    );
    const visibleToB = await tenantTransaction(tenantB, userB, (client) =>
      client.query("SELECT id FROM clients WHERE id = $1", [clientId]),
    );
    expect(visibleToA.rowCount).toBe(1);
    expect(visibleToB.rowCount).toBe(0);
  });

  it("rejects cross-tenant writes at the database layer", async () => {
    await expect(
      tenantTransaction(tenantB, userB, (client) =>
        client.query(
          "INSERT INTO clients (tenant_id, name, company) VALUES ($1, 'Blocked', 'Blocked')",
          [tenantA],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps audit records append-only for the runtime role", async () => {
    const audit = await tenantTransaction(tenantA, userA, (client) =>
      client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'test.created', 'client', $3) RETURNING id`,
        [tenantA, userA, clientId],
      ),
    );
    await expect(
      tenantTransaction(tenantA, userA, (client) =>
        client.query("UPDATE audit_logs SET action = 'tampered' WHERE id = $1", [audit.rows[0].id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("lets a company link its own records", async () => {
    const project = await tenantTransaction(tenantA, userA, (client) =>
      client.query(
        `INSERT INTO projects (tenant_id, client_id, owner_user_id, name)
         VALUES ($1, $2, $3, 'Own project') RETURNING id`,
        [tenantA, clientId, userA],
      ),
    );
    expect(project.rowCount).toBe(1);
  });

  it("refuses a link to another company's record, even by a known id", async () => {
    // RLS hides tenant A's client from B, but foreign-key checks run without row
    // security: only a tenant-scoped key stops B from storing a pointer to it.
    await expect(
      tenantTransaction(tenantB, userB, (client) =>
        client.query(
          "INSERT INTO projects (tenant_id, client_id, name) VALUES ($1, $2, 'Hijack')",
          [tenantB, clientId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      tenantTransaction(tenantB, userB, (client) =>
        client.query(
          "INSERT INTO clients (tenant_id, name, company, created_by) VALUES ($1, 'X', 'X', $2)",
          [tenantB, userA],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("scopes every foreign key between business tables by tenant", async () => {
    // A new table or column that forgets tenant_id in its foreign key fails here,
    // instead of silently reopening the cross-tenant reference.
    const result = await pool.query(`
      SELECT con.conrelid::regclass::text AS child, con.conname
      FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.connamespace = 'public'::regnamespace
        AND con.confrelid <> 'tenants'::regclass
        AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(con.conkey) AS k(attnum)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          WHERE a.attname = 'tenant_id')
      ORDER BY 1, 2`);
    expect(result.rows).toEqual([]);
  });
});
