import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Postgres } from "../packages/postgres/src/index.js";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  MAX_EMBEDDING_UNIT_CHARACTERS,
} from "../packages/retrieval/src/index.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function scopeId(name: string): string {
  const value = required(name);
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

type RevisionRow = {
  corpus_revision: string;
  lexical_revision: string | null;
  vector_revision: string | null;
};

type AggregateRow = {
  total: number;
  containers: number;
  embedding_eligible: number;
  max_embedding_characters: number;
  oversized_embedding_eligible: number;
  table_containers: number;
  table_rows: number;
  table_cells: number;
  table_rows_located: number;
  table_cells_located: number;
  table_containers_embedding_eligible: number;
  table_cells_embedding_eligible: number;
  artifact_table_rows: number;
  artifact_table_cells: number;
};

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const spaceId = scopeId("AKP_AUDIT_SPACE_ID");
  const vaultId = scopeId("AKP_AUDIT_VAULT_ID");
  const db = new Postgres(databaseUrl);

  try {
    const revisionResult = await db.pool.query<RevisionRow>(
      `select corpus_revision,lexical_revision,vector_revision
         from vault_index_revisions
        where space_id=$1 and vault_id=$2`,
      [spaceId, vaultId],
    );
    const revision = revisionResult.rows[0];
    if (!revision) throw new Error("RETRIEVAL_UNITIZATION_SCOPE_NOT_INDEXED");
    if (!revision.lexical_revision) {
      throw new Error("RETRIEVAL_UNITIZATION_LEXICAL_REVISION_MISSING");
    }

    const aggregateResult = await db.pool.query<AggregateRow>(
      `
      select
        count(*)::int total,
        count(*) filter(where u.container_only)::int containers,
        count(*) filter(where u.embedding_eligible)::int embedding_eligible,
        coalesce(max(length(u.body)) filter(where u.embedding_eligible),0)::int
          max_embedding_characters,
        count(*) filter(
          where u.embedding_eligible and length(u.body)>$4
        )::int oversized_embedding_eligible,
        count(*) filter(
          where u.unit_type='TABLE' and u.container_only
        )::int table_containers,
        count(*) filter(where u.unit_type='TABLE_ROW')::int table_rows,
        count(*) filter(where u.unit_type='TABLE_CELL')::int table_cells,
        count(*) filter(
          where u.unit_type='TABLE_ROW'
            and u.locator ? 'table' and u.locator ? 'row'
        )::int table_rows_located,
        count(*) filter(
          where u.unit_type='TABLE_CELL'
            and u.locator ? 'table' and u.locator ? 'row'
            and u.locator ? 'column'
        )::int table_cells_located,
        count(*) filter(
          where u.unit_type='TABLE' and u.container_only
            and u.embedding_eligible
        )::int table_containers_embedding_eligible,
        count(*) filter(
          where u.unit_type='TABLE_CELL' and u.embedding_eligible
        )::int table_cells_embedding_eligible,
        count(*) filter(
          where u.unit_type='TABLE_ROW' and u.artifact_id is not null
        )::int artifact_table_rows,
        count(*) filter(
          where u.unit_type='TABLE_CELL' and u.artifact_id is not null
        )::int artifact_table_cells
      from knowledge_units u
      join knowledge_documents d on d.id=u.document_id
      where u.space_id=$1 and u.vault_id=$2
        and u.corpus_revision=$3
        and u.lifecycle in ('ACTIVE','DISPUTED')
        and d.space_id=$1 and d.vault_id=$2
        and d.lifecycle in ('ACTIVE','DISPUTED')
        and d.refresh_status not in ('STALE_BLOCKED','INVALID')
      `,
      [
        spaceId,
        vaultId,
        revision.lexical_revision,
        MAX_EMBEDDING_UNIT_CHARACTERS,
      ],
    );
    const aggregate = aggregateResult.rows[0];
    if (!aggregate) throw new Error("RETRIEVAL_UNITIZATION_AGGREGATE_MISSING");

    const byTypeResult = await db.pool.query<{
      unit_type: string;
      count: number;
      embedding_eligible: number;
    }>(
      `
      select u.unit_type,
             count(*)::int count,
             count(*) filter(where u.embedding_eligible)::int embedding_eligible
        from knowledge_units u
        join knowledge_documents d on d.id=u.document_id
       where u.space_id=$1 and u.vault_id=$2 and u.corpus_revision=$3
         and u.lifecycle in ('ACTIVE','DISPUTED')
         and d.space_id=$1 and d.vault_id=$2
         and d.lifecycle in ('ACTIVE','DISPUTED')
         and d.refresh_status not in ('STALE_BLOCKED','INVALID')
       group by u.unit_type
       order by u.unit_type
      `,
      [spaceId, vaultId, revision.lexical_revision],
    );

    const activeGenerations = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from embedding_generations
        where space_id=$1 and vault_id=$2 and status='ACTIVE'`,
      [spaceId, vaultId],
    );
    const activeGenerationCount = activeGenerations.rows[0]?.count ?? 0;

    const failures: string[] = [];
    if (revision.lexical_revision !== revision.corpus_revision) {
      failures.push("LEXICAL_REVISION_NOT_CURRENT");
    }
    if (
      revision.vector_revision !== null &&
      revision.vector_revision !== revision.corpus_revision
    ) {
      failures.push("VECTOR_REVISION_NOT_CURRENT");
    }
    if (activeGenerationCount > 1) {
      failures.push("MULTIPLE_ACTIVE_EMBEDDING_GENERATIONS");
    }
    if (aggregate.oversized_embedding_eligible !== 0) {
      failures.push("OVERSIZED_EMBEDDING_ELIGIBLE_UNITS");
    }
    if (aggregate.table_rows !== aggregate.table_rows_located) {
      failures.push("TABLE_ROWS_WITHOUT_STRUCTURAL_COORDINATES");
    }
    if (aggregate.table_cells !== aggregate.table_cells_located) {
      failures.push("TABLE_CELLS_WITHOUT_STRUCTURAL_COORDINATES");
    }
    if (aggregate.table_containers_embedding_eligible !== 0) {
      failures.push("STRUCTURED_TABLE_CONTAINER_EMBEDDING_ELIGIBLE");
    }
    if (aggregate.table_cells_embedding_eligible !== 0) {
      failures.push("TABLE_CELL_EMBEDDING_ELIGIBLE");
    }

    const report = {
      schemaVersion: 1,
      measurement: "CURRENT_RETRIEVAL_UNITIZATION",
      status: failures.length === 0 ? "PASSED" : "FAILED",
      generatedAt: new Date().toISOString(),
      revision: {
        corpus: revision.corpus_revision,
        lexical: revision.lexical_revision,
        vector: revision.vector_revision,
      },
      embeddingProviderBoundary: {
        referenceProvider: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.provider,
        referenceModel: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.model,
        providerMaxTokens:
          LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.runtime.maxTokens,
        unitCharacterBudget: MAX_EMBEDDING_UNIT_CHARACTERS,
        note:
          "Character budget is a structural guard, not an exact provider-token claim.",
      },
      units: {
        total: aggregate.total,
        containers: aggregate.containers,
        embeddingEligible: aggregate.embedding_eligible,
        maxEmbeddingCharacters: aggregate.max_embedding_characters,
        oversizedEmbeddingEligible: aggregate.oversized_embedding_eligible,
        byType: Object.fromEntries(
          byTypeResult.rows.map((row) => [
            row.unit_type,
            {
              total: row.count,
              embeddingEligible: row.embedding_eligible,
            },
          ]),
        ),
      },
      tables: {
        containers: aggregate.table_containers,
        rows: aggregate.table_rows,
        cells: aggregate.table_cells,
        rowsWithCoordinates: aggregate.table_rows_located,
        cellsWithCoordinates: aggregate.table_cells_located,
        artifactLinkedRows: aggregate.artifact_table_rows,
        artifactLinkedCells: aggregate.artifact_table_cells,
      },
      generations: {
        activeEmbeddingGenerations: activeGenerationCount,
      },
      failures,
      privacy:
        "Aggregate-only report: no query text, source content, paths, document IDs or unit IDs.",
    };

    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const reportPath = process.env.AKP_RETRIEVAL_UNITIZATION_REPORT?.trim();
    if (reportPath) {
      const resolved = path.resolve(reportPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, serialized, "utf8");
    }
    process.stdout.write(serialized);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

await main();
