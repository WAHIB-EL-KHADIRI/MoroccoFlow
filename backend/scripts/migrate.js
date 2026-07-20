import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../src/config.js";

const { Pool } = pg;
const config = loadConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "migrations");
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock($1)", [742_026_071]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version varchar(255) PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(directory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    const sql = (await readFile(path.join(directory, file), "utf8")).replace(/^\uFEFF/, "");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query(
      "SELECT checksum FROM schema_migrations WHERE version = $1",
      [file],
    );
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration checksum mismatch: ${file}`);
      }
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
        file,
        checksum,
      ]);
      await client.query("COMMIT");
      process.stdout.write(`Applied ${file}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [742_026_071]).catch(() => {});
  client.release();
  await pool.end();
}
