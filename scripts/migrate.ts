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
      applied_at timestamptz not null default now()
    )
  `);

  const dir = path.resolve("db/migrations");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    const exists = await client.query(
      "select 1 from schema_migrations where name = $1",
      [file],
    );
    if (exists.rowCount) continue;

    const sql = await readFile(path.join(dir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations(name) values ($1)",
        [file],
      );
      await client.query("commit");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}
