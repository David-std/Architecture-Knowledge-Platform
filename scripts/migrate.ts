import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const canonicalUuid =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

async function quarantineLegacyInvalidVaultIds(): Promise<number> {
  const targets = [
    { table: "error_book", column: "metadata" },
    { table: "schema_dry_runs", column: "report" },
    { table: "audit_events", column: "metadata" },
  ] as const;
  let quarantined = 0;
  for (const target of targets) {
    const tableExists = await client.query<{ present: boolean }>(
      "select to_regclass($1) is not null present",
      [`public.${target.table}`],
    );
    if (!tableExists.rows[0]?.present) continue;
    const collision = await client.query<{ count: string }>(
      `select count(*)::text count from ${target.table}
        where ${target.column} ? '_akpLegacyInvalidVaultId013'
          and ${target.column}->>'vaultId' ~ '^[0-9a-fA-F-]{36}$'
          and not (${target.column}->>'vaultId' ~ $1)`,
      [canonicalUuid],
    );
    if (Number(collision.rows[0]?.count ?? 0) > 0) {
      throw new Error(
        `Legacy vaultId quarantine key already exists in ${target.table}; manual migration review is required.`,
      );
    }
    const repaired = await client.query(
      `update ${target.table}
          set ${target.column}=jsonb_set(
            ${target.column} - 'vaultId',
            '{_akpLegacyInvalidVaultId013}',
            ${target.column}->'vaultId',
            true
          )
        where ${target.column}->>'vaultId' ~ '^[0-9a-fA-F-]{36}$'
          and not (${target.column}->>'vaultId' ~ $1)`,
      [canonicalUuid],
    );
    quarantined += repaired.rowCount ?? 0;
  }
  return quarantined;
}

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
    // Git may materialize the same migration as CRLF on Windows and LF in CI.
    // Hash the canonical LF representation so checksums protect SQL content,
    // not the checkout's platform-specific line endings.
    const canonicalSql = sql.replaceAll("\r\n", "\n");
    const checksum = createHash("sha256").update(canonicalSql).digest("hex");
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
      // Migration 013 originally accepted any 36-character hex/hyphen string
      // before casting it to uuid. A malformed legacy metadata value could
      // therefore prevent the migration itself from running. Preserve such a
      // value under an explicit quarantine key and remove only the unsafe
      // `vaultId` projection before applying the immutable migration file.
      // This must share the migration transaction: if the DDL fails, the
      // legacy row remains unchanged and a retry is deterministic.
      const quarantined =
        file === "013_generic_vault_registry.sql"
          ? await quarantineLegacyInvalidVaultIds()
          : 0;
      await client.query(sql);
      await client.query(
        "insert into schema_migrations(name,checksum) values ($1,$2)",
        [file, checksum],
      );
      await client.query("commit");
      if (quarantined > 0) {
        console.warn(
          `Quarantined ${quarantined} malformed legacy vaultId value(s) before ${file}.`,
        );
      }
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
