import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Postgres } from "../packages/postgres/src/index.js";
import {
  queryKnowledge,
  type RetrievalExecutionOptions,
} from "../apps/api/src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const spaceId =
  process.env.AKP_STRUCTURED_ROW_E2E_SPACE_ID ??
  "00000000-0000-0000-0000-000000000003";
const externalId = "CONCEPT-FIXTURE-STRUCTURED-ROW-FRESH";
const fixturePath = "test/fixtures/vault/41-structured/incident-matrices.md";
const outputPath = path.resolve(
  process.env.AKP_STRUCTURED_ROW_E2E_FRESH_REPORT ??
    "reports/ci/imported-structured-row-e2e-fresh.json",
);

interface FixtureDocumentRow {
  vault_id: string;
  lexical_revision: string;
  document_id: string;
  body_cache: string;
  path: string;
}

interface StructuredRow {
  id: string;
  unit_key: string;
  body: string;
  lexical_context: string;
  locator: unknown;
  structural_order: number;
  corpus_revision: string;
}

interface UnitDiagnostic {
  id: string;
  unit_key: string;
  unit_type: string;
  body: string;
  structural_order: number;
}

function locatorSpan(
  locator: unknown,
): { startChar: number; endChar: number } | null {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return null;
  }
  const value = locator as Record<string, unknown>;
  const startChar = Number(value.startChar);
  const endChar = Number(value.endChar);
  return Number.isSafeInteger(startChar) &&
    Number.isSafeInteger(endChar) &&
    startChar >= 0 &&
    endChar >= startChar
    ? { startChar, endChar }
    : null;
}


async function candidateHeadSha(): Promise<string | null> {
  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (!eventPath) return null;
  const event = JSON.parse(await readFile(eventPath, "utf8")) as {
    pull_request?: { head?: { sha?: unknown } };
  };
  const value = event.pull_request?.head?.sha;
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)
    ? value
    : null;
}

const db = new Postgres(databaseUrl);

try {
  const fixture = await db.pool.query<FixtureDocumentRow>(
    `
    select v.id vault_id,i.lexical_revision,d.id document_id,d.body_cache,d.path
      from knowledge_documents d
      join vaults v
        on v.id=d.vault_id and v.space_id=d.space_id
      join vault_index_revisions i
        on i.space_id=d.space_id and i.vault_id=d.vault_id
       and i.lexical_revision=i.corpus_revision
     where d.space_id=$1
       and d.external_id=$2
       and d.lifecycle='ACTIVE'
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
     order by d.updated_at desc
     limit 2
    `,
    [spaceId, externalId],
  );
  if (fixture.rows.length !== 1) {
    throw new Error(
      `STRUCTURED_ROW_FIXTURE_RESOLUTION_FAILED:${fixture.rows.length}`,
    );
  }
  const document = fixture.rows[0]!;

  const units = await db.pool.query<StructuredRow>(
    `
    select id,unit_key,body,lexical_context,locator,structural_order,
           corpus_revision
      from knowledge_units
     where space_id=$1
       and vault_id=$2
       and document_id=$3
       and corpus_revision=$4
       and unit_type='TABLE_ROW'
       and lifecycle='ACTIVE'
     order by structural_order,id
    `,
    [
      spaceId,
      document.vault_id,
      document.document_id,
      document.lexical_revision,
    ],
  );
  const rows = units.rows;
  const silver = rows.find((row) =>
    row.lexical_context.includes("Silver incident matrix"),
  );
  const gold = rows.find((row) =>
    row.lexical_context.includes("Gold incident matrix"),
  );

  const sourceSpansExact =
    rows.length === 2 &&
    rows.every((row) => {
      const span = locatorSpan(row.locator);
      return (
        span !== null &&
        document.body_cache.slice(span.startChar, span.endChar) === row.body
      );
    });

  const positiveQuery =
    "Gold incident matrix Service Gateway Lead Nia Brooks Zone Zone9";
  const negativeQuery =
    "Violet incident matrix Service Gateway Lead Nia Brooks Zone Zone9";

  const strictLexicalOptions: RetrievalExecutionOptions = {
    channels: ["lexical"],
    vaultIds: [document.vault_id],
    deterministicRerank: false,
    allowVectorForBenchmark: true,
    benchmarkDisableAssertionRecall: true,
  };
  const request = (query: string) => ({
    query,
    spaceId,
    vaultId: document.vault_id,
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED" as const,
    mode: "SOURCE_BACKED" as const,
    limit: 5,
  });

  const baseline = await queryKnowledge(
    db,
    request(positiveQuery),
    strictLexicalOptions,
  );
  const candidate = await queryKnowledge(db, request(positiveQuery), {
    ...strictLexicalOptions,
    experimentalStructuredRowLexicalContext: true,
  });
  const negative = await queryKnowledge(db, request(negativeQuery), {
    ...strictLexicalOptions,
    experimentalStructuredRowLexicalContext: true,
  });

  const fullMatches = async (query: string): Promise<string[]> => {
    const result = await db.pool.query<{ id: string }>(
      `
      select id
        from knowledge_units
       where space_id=$1
         and vault_id=$2
         and document_id=$3
         and corpus_revision=$4
         and unit_type='TABLE_ROW'
         and lexical_augmented_search_vector @@ plainto_tsquery('simple',$5)
       order by structural_order,id
      `,
      [
        spaceId,
        document.vault_id,
        document.document_id,
        document.lexical_revision,
        query,
      ],
    );
    return result.rows.map((row) => row.id);
  };
  const positiveFullMatchIds = await fullMatches(positiveQuery);
  const negativeFullMatchIds = await fullMatches(negativeQuery);
  const baselineTopUnitId = baseline[0]?.unitId ?? null;
  const baselineTopUnit = baselineTopUnitId
    ? (
        await db.pool.query<UnitDiagnostic>(
          `
          select id,unit_key,unit_type,body,structural_order
            from knowledge_units
           where id=$1
             and corpus_revision=$2
           limit 1
          `,
          [baselineTopUnitId, document.lexical_revision],
        )
      ).rows[0] ?? null
    : null;

  const checks = {
    importedDocumentResolved:
      document.path === "40-structured/release-matrices.md",
    exactlyTwoStructuredRows: rows.length === 2,
    explicitCaptionsBound: Boolean(silver && gold),
    canonicalBodiesIdentical:
      Boolean(silver && gold) &&
      silver!.body === gold!.body &&
      silver!.body === "| Gateway | Nia Brooks | Zone9 |",
    sourceSpansExact,
    baselineOffDoesNotSelectTargetRow:
      Boolean(gold) &&
      baseline[0]?.unitId !== gold!.id,
    candidateOnSelectsTargetRow:
      Boolean(gold) &&
      candidate[0]?.documentId === document.document_id &&
      candidate[0]?.unitId === gold!.id,
    candidateReportsStructuredContext:
      candidate[0]?.reasons.includes("lexical:structured-context-terms") ===
      true,
    positiveFullMatchIsTargetOnly:
      Boolean(gold) &&
      positiveFullMatchIds.length === 1 &&
      positiveFullMatchIds[0] === gold!.id,
    negativeFullMatchIsZero: negativeFullMatchIds.length === 0,
    negativeStrictRetrievalIsZero: negative.length === 0,
  };
  const outcome = Object.values(checks).every(Boolean) ? "PROMOTE" : "REJECT";

  const report = {
    schemaVersion: 2,
    outcome,
    candidateSha: await candidateHeadSha(),
    productionDefaultsChanged: false,
    featureEnabledByDefault: false,
    assertionRecallDisabledForIsolation: true,
    fixture: {
      path: fixturePath,
      externalId,
      spaceId,
      vaultId: document.vault_id,
      documentId: document.document_id,
      lexicalRevision: document.lexical_revision,
    },
    rows: rows.map((row) => ({
      id: row.id,
      unitKey: row.unit_key,
      structuralOrder: Number(row.structural_order),
      body: row.body,
      lexicalContext: row.lexical_context,
      sourceSpan: locatorSpan(row.locator),
    })),
    queries: {
      positive: positiveQuery,
      negative: negativeQuery,
      baselineTopUnitId,
      baselineTopUnit:
        baselineTopUnit === null
          ? null
          : {
              id: baselineTopUnit.id,
              unitKey: baselineTopUnit.unit_key,
              unitType: baselineTopUnit.unit_type,
              body: baselineTopUnit.body,
              structuralOrder: Number(baselineTopUnit.structural_order),
            },
      candidateTopUnitId: candidate[0]?.unitId ?? null,
      positiveFullMatchIds,
      negativeFullMatchIds,
      negativeHitCount: negative.length,
    },
    checks,
    claimBoundary:
      "This fresh public fixture proves canonical vault import -> persisted TABLE_ROW lexical context -> opt-in target-row selection while default-off does not select that target row. It does not enable the feature by default and does not replace fresh private-vault validation.",
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (outcome !== "PROMOTE") {
    throw new Error("IMPORTED_STRUCTURED_ROW_E2E_FRESH_REJECT");
  }
} finally {
  await db.close();
}
