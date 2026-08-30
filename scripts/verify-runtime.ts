import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

type QueryCountRow = { count: number | string };

type Check = {
  name: string;
  passed: boolean;
  detail: unknown;
};

type Observation = {
  name: string;
  detail: unknown;
};

type Invariant = {
  name: string;
  sql: string;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const requirePopulatedCorpus =
  process.argv.includes("--require-populated") ||
  /^(1|true|yes)$/i.test(process.env.AKP_RUNTIME_REQUIRE_POPULATED ?? "");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const checks: Check[] = [];
const observations: Observation[] = [];
const observedCounts = new Map<string, number>();

function errorDetail(error: unknown): { error: string } {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

function addCheck(name: string, passed: boolean, detail: unknown): void {
  checks.push({ name, passed, detail });
}

async function expectedMigrationInventory(): Promise<
  Array<{ name: string; checksum: string }>
> {
  const directory = path.resolve("db/migrations");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = (
        await readFile(path.join(directory, name), "utf8")
      ).replaceAll("\r\n", "\n");
      return {
        name,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

async function verifyMigrationInventory(): Promise<void> {
  const expected = await expectedMigrationInventory();
  const actualResult = await client.query<{
    name: string;
    checksum: string | null;
  }>("select name,checksum from schema_migrations order by name");
  const actual = actualResult.rows.map((row) => ({
    name: row.name,
    checksum: row.checksum ?? "",
  }));
  const passed =
    expected.length === actual.length &&
    expected.every(
      (migration, index) =>
        migration.name === actual[index]?.name &&
        migration.checksum === actual[index]?.checksum,
    );
  addCheck("migration inventory", passed, {
    expectedCount: expected.length,
    actualCount: actual.length,
    expected,
    actual,
  });
}

const requiredRelations = [
  "schema_migrations",
  "organizations",
  "users",
  "spaces",
  "memberships",
  "sources",
  "source_artifacts",
  "knowledge_documents",
  "knowledge_versions",
  "knowledge_relations",
  "evidence",
  "embeddings",
  "ingest_jobs",
  "reviews",
  "review_comments",
  "context_packets",
  "audit_events",
  "eval_cases",
  "eval_runs",
  "vaults",
  "vault_import_runs",
  "vault_import_issues",
  "api_tokens",
  "projects",
  "agent_sessions",
  "ingest_job_events",
  "compilation_plans",
  "knowledge_units",
  "embedding_generations",
  "unit_embeddings",
  "index_revisions",
  "contradiction_clusters",
  "contradiction_members",
  "document_leases",
  "knowledge_lint_runs",
  "error_book",
  "publication_locks",
  "idempotency_records",
  "document_evidence",
  "web_sessions",
  "schema_dry_runs",
  "repository_publication_locks",
  "vault_index_revisions",
  "vault_memberships",
  "event_outbox",
  "outbox_events",
  "event_consumers",
  "event_deliveries",
  "event_consumptions",
  "event_delivery_attempts",
  "event_quarantine",
  "event_dead_letters",
  "incremental_index_runs",
] as const;

async function verifyRequiredRelations(): Promise<boolean> {
  const result = await client.query<{ name: string; present: boolean }>(
    `
      select relation_name as name,
             to_regclass('public.' || relation_name) is not null as present
        from unnest($1::text[]) as required(relation_name)
       order by relation_name
    `,
    [requiredRelations],
  );
  const missing = result.rows
    .filter((row) => !row.present)
    .map((row) => row.name);
  addCheck("required runtime relations", missing.length === 0, {
    requiredCount: requiredRelations.length,
    presentCount: requiredRelations.length - missing.length,
    missing,
  });
  return missing.length === 0;
}

async function verifyRequiredExtensions(): Promise<void> {
  const expected = ["pgcrypto", "vector"];
  const result = await client.query<{ extname: string }>(
    "select extname from pg_extension where extname=any($1::text[]) order by extname",
    [expected],
  );
  const present = result.rows.map((row) => row.extname);
  const missing = expected.filter((name) => !present.includes(name));
  addCheck("required database extensions", missing.length === 0, {
    expected,
    present,
    missing,
  });
}

async function verifyValidatedConstraints(): Promise<void> {
  const result = await client.query<QueryCountRow>(
    `
      select count(*)::int as count
        from pg_constraint
       where contype in ('f', 'c')
         and not convalidated
    `,
  );
  const invalidConstraints = Number(result.rows[0]?.count ?? 0);
  addCheck(
    "validated foreign-key and check constraints",
    invalidConstraints === 0,
    {
      invalidConstraints,
    },
  );
}

async function verifyDefaultCredential(): Promise<void> {
  const result = await client.query<{
    matching_tokens: number | string;
    active_tokens: number | string;
  }>(
    `
      select count(*)::int as matching_tokens,
             count(*) filter (where revoked_at is null)::int as active_tokens
        from api_tokens
       where token_hash='1734d503f6aa6a047c36d113cbad769f719c93784b469b771c4c3e7c63adbefd'
    `,
  );
  const matchingTokens = Number(result.rows[0]?.matching_tokens ?? 0);
  const activeTokens = Number(result.rows[0]?.active_tokens ?? 0);
  addCheck("default credential revoked", activeTokens === 0, {
    matchingTokens,
    activeDefaultTokens: activeTokens,
  });
}

async function verifyVaultRegistry(): Promise<void> {
  const result = await client.query<{
    total: number | string;
    read_only: number | string;
    writable: number | string;
    invalid: number | string;
  }>(
    `
      select count(*)::int as total,
             count(*) filter (where read_only)::int as read_only,
             count(*) filter (where not read_only)::int as writable,
             count(*) filter (
               where btrim(vault_key) = ''
                  or vault_key !~ '^[a-z0-9][a-z0-9-]{1,62}$'
                  or btrim(canonical_path) = ''
                  or btrim(local_path) = ''
             )::int as invalid
        from vaults
    `,
  );
  const row = result.rows[0];
  const total = Number(row?.total ?? 0);
  const readOnly = Number(row?.read_only ?? 0);
  const writable = Number(row?.writable ?? 0);
  const invalid = Number(row?.invalid ?? 0);
  observations.push({
    name: "registered vaults",
    detail: { total, readOnly, writable },
  });
  addCheck("vault registry integrity", invalid === 0, {
    total,
    invalid,
    readOnly,
    writable,
  });
}

async function verifyOutboxTriggers(): Promise<void> {
  const expected = [
    "event_outbox_seed_delivery",
    "event_outbox_append_only_update",
    "event_delivery_attempts_append_only_update",
    "event_quarantine_append_only_delete",
  ];
  const result = await client.query<{ name: string }>(
    `
      select t.tgname as name
        from pg_trigger t
        join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal
         and t.tgname=any($1::text[])
       order by t.tgname
    `,
    [expected],
  );
  const present = result.rows.map((row) => row.name);
  const missing = expected.filter((name) => !present.includes(name));
  addCheck("durable outbox triggers", missing.length === 0, {
    expected,
    present,
    missing,
  });
}

async function verifyOutboxAttemptHistoryKey(): Promise<void> {
  const result = await client.query<{
    index_definition: string | null;
    legacy_unique_constraints: number | string;
  }>(
    `
      select pg_get_indexdef(to_regclass(
               'public.event_delivery_attempts_outcome_key'
             )) as index_definition,
             (
               select count(*)::int
                 from pg_constraint
                where conrelid='public.event_delivery_attempts'::regclass
                  and contype='u'
             ) as legacy_unique_constraints
    `,
  );
  const row = result.rows[0];
  const definition = String(row?.index_definition ?? "");
  const legacyUniqueConstraints = Number(row?.legacy_unique_constraints ?? 0);
  const expectedColumns =
    "(event_id, consumer_name, delivery_generation, attempt, outcome)";
  addCheck(
    "outbox attempt outcome uniqueness",
    definition.includes("UNIQUE INDEX") &&
      definition.includes(expectedColumns) &&
      legacyUniqueConstraints === 0,
    {
      indexPresent: Boolean(definition),
      expectedColumns,
      legacyUniqueConstraints,
    },
  );
}

async function verifyInvariants(
  groupName: string,
  invariants: readonly Invariant[],
): Promise<void> {
  const sql = `
    select invariant, count(*)::int as violations
      from (
        ${invariants
          .map(({ sql: invariantSql }) => invariantSql.trim())
          .join("\n        union all\n")}
      ) as violation_rows
     group by invariant
     order by invariant
  `;

  const result = await client.query<{
    invariant: string;
    violations: number | string;
  }>(sql);
  const violations = new Map(
    result.rows.map((row) => [row.invariant, Number(row.violations)]),
  );
  for (const invariant of invariants) {
    const count = violations.get(invariant.name) ?? 0;
    addCheck(`${groupName}: ${invariant.name}`, count === 0, {
      violations: count,
    });
  }
}

const scopeInvariants: Invariant[] = [
  {
    name: "knowledge_documents.vault-space",
    sql: `
      select 'knowledge_documents.vault-space'::text as invariant
        from knowledge_documents d
        left join vaults v on v.id=d.vault_id
       where d.vault_id is not null
         and (v.id is null or d.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "knowledge_units.vault-space",
    sql: `
      select 'knowledge_units.vault-space'::text as invariant
        from knowledge_units u
        left join vaults v on v.id=u.vault_id
       where u.vault_id is not null
         and (v.id is null or u.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "embedding_generations.vault-space",
    sql: `
      select 'embedding_generations.vault-space'::text as invariant
        from embedding_generations g
        left join vaults v on v.id=g.vault_id
       where g.vault_id is not null
         and (v.id is null or g.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "sources.vault-space",
    sql: `
      select 'sources.vault-space'::text as invariant
        from sources s
        left join vaults v on v.id=s.vault_id
       where s.vault_id is not null
         and (v.id is null or s.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "evidence.vault-space",
    sql: `
      select 'evidence.vault-space'::text as invariant
        from evidence e
        left join vaults v on v.id=e.vault_id
       where e.vault_id is not null
         and (v.id is null or e.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "ingest_jobs.vault-space",
    sql: `
      select 'ingest_jobs.vault-space'::text as invariant
        from ingest_jobs j
        left join vaults v on v.id=j.vault_id
       where j.vault_id is not null
         and (v.id is null or j.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "reviews.vault-space",
    sql: `
      select 'reviews.vault-space'::text as invariant
        from reviews r
        left join vaults v on v.id=r.vault_id
       where r.vault_id is not null
         and (v.id is null or r.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "context_packets.vault-space",
    sql: `
      select 'context_packets.vault-space'::text as invariant
        from context_packets p
        left join vaults v on v.id=p.vault_id
       where p.vault_id is not null
         and (v.id is null or p.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "eval_runs.vault-space",
    sql: `
      select 'eval_runs.vault-space'::text as invariant
        from eval_runs r
        left join vaults v on v.id=r.vault_id
       where r.vault_id is not null
         and (v.id is null or r.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "eval_cases.vault-space",
    sql: `
      select 'eval_cases.vault-space'::text as invariant
        from eval_cases c
        left join vaults v on v.id=c.vault_id
       where c.vault_id is not null
         and (v.id is null or c.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "agent_sessions.vault-space",
    sql: `
      select 'agent_sessions.vault-space'::text as invariant
        from agent_sessions s
        left join vaults v on v.id=s.vault_id
       where s.vault_id is not null
         and (v.id is null or s.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "contradiction_clusters.vault-space",
    sql: `
      select 'contradiction_clusters.vault-space'::text as invariant
        from contradiction_clusters c
        left join vaults v on v.id=c.vault_id
       where c.vault_id is not null
         and (v.id is null or c.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "knowledge_lint_runs.vault-space",
    sql: `
      select 'knowledge_lint_runs.vault-space'::text as invariant
        from knowledge_lint_runs l
        left join vaults v on v.id=l.vault_id
       where l.vault_id is not null
         and (v.id is null or l.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "error_book.vault-space",
    sql: `
      select 'error_book.vault-space'::text as invariant
        from error_book e
        left join vaults v on v.id=e.vault_id
       where e.vault_id is not null
         and (v.id is null or e.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "schema_dry_runs.vault-space",
    sql: `
      select 'schema_dry_runs.vault-space'::text as invariant
        from schema_dry_runs s
        left join vaults v on v.id=s.vault_id
       where s.vault_id is not null
         and (v.id is null or s.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "audit_events.vault-space",
    sql: `
      select 'audit_events.vault-space'::text as invariant
        from audit_events a
        left join vaults v on v.id=a.vault_id
       where a.vault_id is not null
         and (v.id is null or a.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "audit_events.organization-space",
    sql: `
      select 'audit_events.organization-space'::text as invariant
        from audit_events a
        join spaces s on s.id=a.space_id
       where a.organization_id is not null
         and a.organization_id is distinct from s.organization_id
    `,
  },
  {
    name: "projects.vault-space",
    sql: `
      select 'projects.vault-space'::text as invariant
        from projects p
        left join vaults v on v.id=p.vault_id
       where p.vault_id is not null
         and (v.id is null or p.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "incremental_index_runs.vault-space",
    sql: `
      select 'incremental_index_runs.vault-space'::text as invariant
        from incremental_index_runs r
        left join vaults v on v.id=r.vault_id
       where r.vault_id is not null
         and (v.id is null or r.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "event_outbox.vault-space",
    sql: `
      select 'event_outbox.vault-space'::text as invariant
        from event_outbox e
        left join vaults v on v.id=e.vault_id
       where e.vault_id is not null
         and (v.id is null or e.space_id is distinct from v.space_id)
    `,
  },
  {
    name: "event_outbox.organization-space",
    sql: `
      select 'event_outbox.organization-space'::text as invariant
        from event_outbox e
        join spaces s on s.id=e.space_id
       where e.organization_id is not null
         and e.organization_id is distinct from s.organization_id
    `,
  },
  {
    name: "vault_index_revisions.vault-space",
    sql: `
      select 'vault_index_revisions.vault-space'::text as invariant
        from vault_index_revisions r
        left join vaults v on v.id=r.vault_id
       where v.id is null or r.space_id is distinct from v.space_id
    `,
  },
];

const lineageInvariants: Invariant[] = [
  {
    name: "knowledge_units.document-scope",
    sql: `
      select 'knowledge_units.document-scope'::text as invariant
        from knowledge_units u
        join knowledge_documents d on d.id=u.document_id
       where u.space_id is distinct from d.space_id
          or u.vault_id is distinct from d.vault_id
    `,
  },
  {
    name: "knowledge_units.parent-scope",
    sql: `
      select 'knowledge_units.parent-scope'::text as invariant
        from knowledge_units u
        left join knowledge_units p on p.id=u.parent_unit_id
       where u.parent_unit_id is not null
         and (
           p.id is null
           or p.document_id is distinct from u.document_id
           or p.space_id is distinct from u.space_id
           or p.vault_id is distinct from u.vault_id
         )
    `,
  },
  {
    name: "unit_embeddings.generation-scope",
    sql: `
      select 'unit_embeddings.generation-scope'::text as invariant
        from unit_embeddings e
        join knowledge_units u on u.id=e.unit_id
        join embedding_generations g on g.id=e.generation_id
       where u.space_id is distinct from g.space_id
          or u.vault_id is distinct from g.vault_id
    `,
  },
  {
    name: "evidence.source-scope",
    sql: `
      select 'evidence.source-scope'::text as invariant
        from evidence e
        join sources s on s.id=e.source_id
       where e.space_id is distinct from s.space_id
          or e.vault_id is distinct from s.vault_id
    `,
  },
  {
    name: "evidence.artifact-source",
    sql: `
      select 'evidence.artifact-source'::text as invariant
        from evidence e
        left join source_artifacts a on a.id=e.artifact_id
       where e.artifact_id is not null
         and (a.id is null or a.source_id is distinct from e.source_id)
    `,
  },
  {
    name: "document_evidence.document-scope",
    sql: `
      select 'document_evidence.document-scope'::text as invariant
        from document_evidence de
        join knowledge_documents d on d.id=de.document_id
        join evidence e on e.id=de.evidence_id
       where d.space_id is distinct from e.space_id
          or d.vault_id is distinct from e.vault_id
    `,
  },
  {
    name: "knowledge_relations.document-scope",
    sql: `
      select 'knowledge_relations.document-scope'::text as invariant
        from knowledge_relations r
        join knowledge_documents f on f.id=r.from_document_id
        join knowledge_documents t on t.id=r.to_document_id
       where r.space_id is distinct from f.space_id
          or r.space_id is distinct from t.space_id
          or (
            f.vault_id is not null
            and t.vault_id is not null
            and f.vault_id is distinct from t.vault_id
          )
    `,
  },
  {
    name: "compilation_plans.job-source",
    sql: `
      select 'compilation_plans.job-source'::text as invariant
        from compilation_plans p
        join ingest_jobs j on j.id=p.job_id
        left join sources s on s.id=p.source_id
       where p.source_id is not null
         and (
           s.id is null
           or j.space_id is distinct from s.space_id
           or j.vault_id is distinct from s.vault_id
         )
    `,
  },
  {
    name: "agent_sessions.project-scope",
    sql: `
      select 'agent_sessions.project-scope'::text as invariant
        from agent_sessions s
        join projects p on p.id=s.project_id
       where s.space_id is distinct from p.space_id
          or s.vault_id is distinct from p.vault_id
    `,
  },
  {
    name: "contradiction_members.cluster-scope",
    sql: `
      select 'contradiction_members.cluster-scope'::text as invariant
        from contradiction_members m
        join contradiction_clusters c on c.id=m.cluster_id
        join knowledge_documents d on d.id=m.document_id
       where c.space_id is distinct from d.space_id
          or (
            c.vault_id is not null
            and c.vault_id is distinct from d.vault_id
          )
    `,
  },
  {
    name: "document_leases.document-scope",
    sql: `
      select 'document_leases.document-scope'::text as invariant
        from document_leases l
        join knowledge_documents d on d.id=l.document_id
       where l.vault_id is distinct from d.vault_id
    `,
  },
  {
    name: "eval_runs.trigger-event-scope",
    sql: `
      select 'eval_runs.trigger-event-scope'::text as invariant
        from eval_runs r
        join event_outbox e on e.event_id=r.trigger_event_id
       where r.trigger_event_id is not null
         and (
           r.space_id is distinct from e.space_id
           or r.vault_id is distinct from e.vault_id
         )
    `,
  },
  {
    name: "incremental_index_runs.event-scope",
    sql: `
      select 'incremental_index_runs.event-scope'::text as invariant
        from incremental_index_runs r
        join event_outbox e on e.event_id=r.event_id
       where r.event_id is not null
         and (
           r.space_id is distinct from e.space_id
           or r.vault_id is distinct from e.vault_id
         )
    `,
  },
];

const dataInvariants: Invariant[] = [
  {
    name: "sources.sha256-format",
    sql: `
      select 'sources.sha256-format'::text as invariant
        from sources
       where sha256 !~ '^[a-f0-9]{64}$'
    `,
  },
  {
    name: "api_tokens.scope-shape",
    sql: `
      select 'api_tokens.scope-shape'::text as invariant
        from api_tokens
       where revoked_at is null
         and (
           jsonb_typeof(scopes) <> 'object'
           or jsonb_typeof(scopes->'spaces') <> 'array'
         )
    `,
  },
  {
    name: "web_sessions.scope-shape",
    sql: `
      select 'web_sessions.scope-shape'::text as invariant
        from web_sessions
       where revoked_at is null
         and (
           jsonb_typeof(scopes) <> 'object'
           or jsonb_typeof(scopes->'spaces') <> 'array'
         )
    `,
  },
  {
    name: "knowledge_units.nonnegative-estimates",
    sql: `
      select 'knowledge_units.nonnegative-estimates'::text as invariant
        from knowledge_units
       where token_estimate < 0
          or structural_order < 0
    `,
  },
];

const corpusRequirements = [
  {
    name: "read-only vault",
    minimum: 1,
    sql: "select count(*)::int as count from vaults where read_only",
  },
  {
    name: "knowledge documents",
    minimum: 300,
    sql: "select count(*)::int as count from knowledge_documents",
  },
  {
    name: "knowledge relations",
    minimum: 100,
    sql: "select count(*)::int as count from knowledge_relations",
  },
  {
    name: "hierarchical units",
    minimum: 1000,
    sql: "select count(*)::int as count from knowledge_units",
  },
  {
    name: "unit embeddings",
    minimum: 1000,
    sql: "select count(*)::int as count from unit_embeddings",
  },
  {
    name: "index revisions",
    minimum: 1,
    sql: "select count(*)::int as count from index_revisions",
  },
  {
    name: "immutable sources",
    minimum: 2,
    sql: "select count(*)::int as count from sources where length(sha256)=64",
  },
  {
    name: "source artifacts",
    minimum: 2,
    sql: "select count(*)::int as count from source_artifacts",
  },
  {
    name: "document evidence",
    minimum: 1,
    sql: "select count(*)::int as count from document_evidence",
  },
  {
    name: "completed jobs",
    minimum: 1,
    sql: "select count(*)::int as count from ingest_jobs where state='COMPLETED'",
  },
  {
    name: "approved reviews",
    minimum: 1,
    sql: "select count(*)::int as count from reviews where status='APPROVED'",
  },
  {
    name: "rejected reviews",
    minimum: 1,
    sql: "select count(*)::int as count from reviews where status='REJECTED'",
  },
  {
    name: "context packets",
    minimum: 1,
    sql: "select count(*)::int as count from context_packets",
  },
  {
    name: "audit events",
    minimum: 3,
    sql: "select count(*)::int as count from audit_events",
  },
] as const;

async function observeCount(name: string, sql: string): Promise<number | null> {
  try {
    const result = await client.query<QueryCountRow>(sql);
    const value = Number(result.rows[0]?.count ?? 0);
    observedCounts.set(name, value);
    observations.push({ name, detail: { value } });
    return value;
  } catch (error) {
    observations.push({ name, detail: errorDetail(error) });
    return null;
  }
}

async function collectCorpusCounts(): Promise<void> {
  const requirements = [
    {
      name: "registered read-only vaults",
      sql: "select count(*)::int as count from vaults where read_only",
    },
    ...corpusRequirements.filter(
      (requirement) => requirement.name !== "read-only vault",
    ),
  ];
  for (const requirement of requirements) {
    await observeCount(requirement.name, requirement.sql);
  }

  if (!requirePopulatedCorpus) return;
  for (const requirement of corpusRequirements) {
    const observationName =
      requirement.name === "read-only vault"
        ? "registered read-only vaults"
        : requirement.name;
    const value = observedCounts.get(observationName);
    addCheck(
      `populated corpus: ${requirement.name}`,
      value !== undefined && value >= requirement.minimum,
      {
        value: value ?? null,
        minimum: requirement.minimum,
        explicitOptIn: true,
      },
    );
  }
}

try {
  try {
    await verifyMigrationInventory();
  } catch (error) {
    addCheck("migration inventory", false, errorDetail(error));
  }

  let schemaReady = false;
  try {
    schemaReady = await verifyRequiredRelations();
  } catch (error) {
    addCheck("required runtime relations", false, errorDetail(error));
  }

  if (schemaReady) {
    try {
      await verifyRequiredExtensions();
    } catch (error) {
      addCheck("required database extensions", false, errorDetail(error));
    }
    try {
      await verifyValidatedConstraints();
    } catch (error) {
      addCheck(
        "validated foreign-key and check constraints",
        false,
        errorDetail(error),
      );
    }
    try {
      await verifyDefaultCredential();
    } catch (error) {
      addCheck("default credential revoked", false, errorDetail(error));
    }
    try {
      await verifyVaultRegistry();
    } catch (error) {
      addCheck("vault registry integrity", false, errorDetail(error));
    }
    try {
      await verifyOutboxTriggers();
    } catch (error) {
      addCheck("durable outbox triggers", false, errorDetail(error));
    }
    try {
      await verifyOutboxAttemptHistoryKey();
    } catch (error) {
      addCheck("outbox attempt outcome uniqueness", false, errorDetail(error));
    }
    for (const [groupName, invariants] of [
      ["scope isolation", scopeInvariants],
      ["lineage isolation", lineageInvariants],
      ["data integrity", dataInvariants],
    ] as const) {
      try {
        await verifyInvariants(groupName, invariants);
      } catch (error) {
        addCheck(`${groupName} invariants`, false, errorDetail(error));
      }
    }
    await collectCorpusCounts();
  } else {
    observations.push({
      name: "corpus counts",
      detail: { skipped: "required runtime relations are missing" },
    });
  }
} finally {
  await client.end();
}

const failed = checks.filter((check) => !check.passed);
console.log(
  JSON.stringify(
    {
      status: failed.length ? "FAILED" : "PASSED",
      mode: requirePopulatedCorpus ? "populated" : "bootstrap",
      checks,
      observations,
      summary: {
        checks: checks.length,
        failedChecks: failed.length,
        observations: observations.length,
        corpusThresholds: requirePopulatedCorpus ? "enforced" : "observed-only",
      },
    },
    null,
    2,
  ),
);
if (failed.length) process.exitCode = 1;
