import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text,
      applied_at timestamptz not null default now()
    )
  `);
  await client.query(
    "alter table schema_migrations add column if not exists checksum text",
  );
  await client.query(
    "select pg_advisory_lock(hashtext('architecture-knowledge-platform:migrations'))",
  );

  const dir = path.resolve("db/migrations");
  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const exists = await client.query<{ checksum: string | null }>(
      "select checksum from schema_migrations where name = $1",
      [file],
    );
    if (exists.rowCount) {
      const recorded = exists.rows[0]?.checksum;
      if (recorded && recorded !== checksum) {
        throw new Error(`Applied migration checksum changed: ${file}`);
      }
      if (!recorded) {
        await client.query(
          "update schema_migrations set checksum=$2 where name=$1",
          [file, checksum],
        );
      }
      continue;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations(name,checksum) values ($1,$2)",
        [file, checksum],
      );
      await client.query("commit");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client
    .query(
      "select pg_advisory_unlock(hashtext('architecture-knowledge-platform:migrations'))",
    )
    .catch(() => undefined);
  await client.end();
}
