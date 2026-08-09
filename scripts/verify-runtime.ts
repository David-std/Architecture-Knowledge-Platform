import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const checks: Array<{ name: string; passed: boolean; detail: unknown }> = [];
async function count(
  name: string,
  sql: string,
  minimum: number,
): Promise<void> {
  const result = await client.query<{ count: number }>(sql);
  const value = Number(result.rows[0]?.count ?? 0);
  checks.push({ name, passed: value >= minimum, detail: { value, minimum } });
}

try {
  await count(
    "migrations",
    "select count(*)::int count from schema_migrations",
    9,
  );
  await count(
    "read-only vault",
    "select count(*)::int count from vaults where read_only",
    1,
  );
  await count(
    "knowledge documents",
    "select count(*)::int count from knowledge_documents",
    300,
  );
  await count(
    "knowledge relations",
    "select count(*)::int count from knowledge_relations",
    100,
  );
  await count(
    "hierarchical units",
    "select count(*)::int count from knowledge_units",
    1000,
  );
  await count(
    "unit embeddings",
    "select count(*)::int count from unit_embeddings",
    1000,
  );
  await count(
    "index revisions",
    "select count(*)::int count from index_revisions",
    1,
  );
  await count(
    "immutable sources",
    "select count(*)::int count from sources where length(sha256)=64",
    2,
  );
  await count(
    "source artifacts",
    "select count(*)::int count from source_artifacts",
    2,
  );
  await count(
    "document evidence",
    "select count(*)::int count from document_evidence",
    1,
  );
  await count(
    "completed jobs",
    "select count(*)::int count from ingest_jobs where state='COMPLETED'",
    1,
  );
  await count(
    "approved reviews",
    "select count(*)::int count from reviews where status='APPROVED'",
    1,
  );
  await count(
    "rejected reviews",
    "select count(*)::int count from reviews where status='REJECTED'",
    1,
  );
  await count(
    "context packets",
    "select count(*)::int count from context_packets",
    1,
  );
  await count(
    "audit events",
    "select count(*)::int count from audit_events",
    3,
  );
  const revokedDefault = await client.query<{ count: number }>(
    `
    select count(*)::int count from api_tokens
     where revoked_at is null
       and token_hash='1734d503f6aa6a047c36d113cbad769f719c93784b469b771c4c3e7c63adbefd'
    `,
  );
  checks.push({
    name: "default credential revoked",
    passed: Number(revokedDefault.rows[0]?.count ?? 0) === 0,
    detail: { activeDefaultTokens: Number(revokedDefault.rows[0]?.count ?? 0) },
  });
} finally {
  await client.end();
}

const failed = checks.filter((check) => !check.passed);
console.log(
  JSON.stringify(
    { status: failed.length ? "FAILED" : "PASSED", checks },
    null,
    2,
  ),
);
if (failed.length) process.exitCode = 1;
