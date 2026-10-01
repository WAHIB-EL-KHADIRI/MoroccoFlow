import fastifyPostgres from "@fastify/postgres";
import pg from "pg";

// A DATE column is a calendar day, not an instant. pg's default parser turns it into
// a Date at the server's local midnight, which serialises as the previous day on any
// host east of UTC. Keep it as the "YYYY-MM-DD" string PostgreSQL sent.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Invalid DATABASE_ROLE");
  return `"${value}"`;
}

export async function databasePlugin(app, options) {
  await app.register(fastifyPostgres, {
    connectionString: options.config.databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: options.config.nodeEnv === "test",
  });

  const runtimeRole = quoteIdentifier(options.config.databaseRole);

  async function transaction(operation, auth) {
    const client = await app.pg.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${runtimeRole}`);
      if (auth) {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [auth.tenantId]);
        await client.query("SELECT set_config('app.user_id', $1, true)", [auth.userId]);
      }
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

  app.decorate("withTenant", async function withTenant(auth, operation) {
    return transaction(operation, auth);
  });

  app.decorate("withRuntimeRole", async function withRuntimeRole(operation) {
    return transaction(operation);
  });

  app.decorate("databaseReady", async function databaseReady() {
    const result = await app.pg.query("SELECT 1 AS ready");
    return result.rows[0]?.ready === 1;
  });
}
