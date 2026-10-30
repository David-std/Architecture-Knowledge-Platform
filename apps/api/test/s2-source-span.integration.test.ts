import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import type { SearchHit } from "@akp/contracts";
import { buildEmbeddingIndex } from "@akp/indexing";
import {
  assessRetrievalAnswerability,
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  QueryEmbeddingService,
} from "@akp/retrieval";
import {
  scoreS2SpanObservations,
  type S2SpanFixture,
  type S2SpanObservation,
} from "@akp/evaluation";
import { queryKnowledge } from "../src/routes/search.js";
import type { S2AdmissionShadowObservation } from "../src/s2-admission-shadow.js";
import {
  rebindS2AdmissionToSource,
  type S2AuthorizedSourceSnapshot,
} from "../src/s2-source-rebind.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.AKP_S2_SPAN_BASELINE === "1";
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const datasetPath = path.resolve(
  import.meta.dirname,
  "../../../evals/registered/s2-source-span-holdout.json",
);
const datasetBytes = readFileSync(datasetPath);
const frozenBlobSha1 = "a61a24df46c0351115cd09e079ae0d8383033082";
const dataset = JSON.parse(datasetBytes.toString("utf8")) as S2SpanFixture;

interface Fixture {
  organizationId: string;
  spaceId: string;
  revision: string;
  vaultIds: Map<string, string>;
  unitIds: Map<string, string>;
}
function makeFixture(): Fixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    revision: "s2-source-units-" + randomUUID(),
    vaultIds: new Map(
      dataset.sourceDocuments.map((source) => [source.id, randomUUID()]),
    ),
    unitIds: new Map(
      dataset.sourceDocuments.flatMap((source) =>
        source.units.map((unit) => [unit.id, randomUUID()] as const),
      ),
    ),
  };
}
async function seed(db: Postgres, f: Fixture): Promise<void> {
  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [
      f.organizationId,
      "s2-baseline-" + f.organizationId.slice(0, 8),
      "Disposable synthetic S2 baseline",
    ],
  );
  await db.pool.query(
    "insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path) " +
      "values($1,$2,$3,'S2 baseline','PRIVATE',$4)",
    [
      f.spaceId,
      f.organizationId,
      "s2-baseline-" + f.spaceId.slice(0, 8),
      "test/s2/" + f.spaceId,
    ],
  );
  for (const source of dataset.sourceDocuments) {
    const vaultId = f.vaultIds.get(source.id)!;
    const documentId = randomUUID();
    const body = source.units.map((unit) => unit.text).join("\n\n");
    const title = "S2 source " + source.domain;
    const sourcePath = "s2/" + source.id + ".md";
    await db.pool.query(
      "insert into vaults(id,space_id,canonical_path,name,read_only," +
        "current_revision,vault_key,local_path,visibility,enabled) " +
        "values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)",
      [
        vaultId,
        f.spaceId,
        "test/s2/" + vaultId,
        title,
        f.revision,
        "s2-" + vaultId.slice(0, 8),
      ],
    );
    await db.pool.query(
      "insert into vault_index_revisions(space_id,vault_id,corpus_revision," +
        "lexical_revision,vector_revision,graph_revision,context_pack_revision," +
        "status,warnings) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)",
      [f.spaceId, vaultId, f.revision],
    );
    await db.pool.query(
      "insert into knowledge_documents(id,space_id,vault_id,path,external_id," +
        "title,type,lifecycle,trust_tier,current_revision,body_cache," +
        "frontmatter,aliases,layer,content_hash,token_estimate,raw_links) " +
        "values($1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED'," +
        "$7,$8,$9::jsonb,'{}','concept',$10,$11,'[]'::jsonb)",
      [
        documentId,
        f.spaceId,
        vaultId,
        sourcePath,
        source.id,
        title,
        f.revision,
        body,
        JSON.stringify({
          id: source.id,
          title,
          synthetic_approval_for_isolated_fixture: true,
        }),
        digest(body),
        Math.max(1, body.split(/\s+/u).length),
      ],
    );
    for (const [index, unit] of source.units.entries()) {
      await db.pool.query(
        "insert into knowledge_units(id,document_id,space_id,vault_id," +
          "unit_key,unit_type,heading_path,body,content_hash,corpus_revision," +
          "document_revision,lifecycle,trust_tier,source_ids,token_estimate," +
          "parent_unit_id,permissions,locator,structural_order,container_only," +
          "embedding_eligible) values($1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8," +
          "$9,$9,'ACTIVE','HUMAN_REVIEWED','{}',$10,null,'{}'::jsonb," +
          "$11::jsonb,$12,false,true)",
        [
          f.unitIds.get(unit.id),
          documentId,
          f.spaceId,
          vaultId,
          unit.id,
          [title],
          unit.text,
          digest(unit.text),
          f.revision,
          Math.max(1, unit.text.split(/\s+/u).length),
          JSON.stringify({ sourcePath, logicalUnitId: unit.id }),
          index + 1,
        ],
      );
    }
  }
}
async function cleanup(db: Postgres, f: Fixture): Promise<void> {
  const vaultIds = [...f.vaultIds.values()];
  await db.pool.query(
    "delete from knowledge_units where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query(
    "delete from knowledge_documents where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query(
    "delete from vault_index_revisions where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    vaultIds,
  ]);
  await db.pool.query("delete from spaces where id=$1", [f.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    f.organizationId,
  ]);
}
interface ScopedIndexProbe {
  queryTerms: string;
  indexedUnitsInVault: number;
  strictMatchingUnitsInVault: number;
  goldUnitsPresent: number;
  goldUnitsMatchingStrictQuery: number;
}

/**
 * Diagnostic-only SQL. This does not rank evidence or modify retrieval
 * policy. The frozen question is passed unchanged through plainto_tsquery,
 * exactly as the maintained lexical channel does. Never count a missing gold
 * unit as a lexical nonmatch.
 */
async function inspectStrictLexicalIndex(
  db: Postgres,
  vaultId: string,
  revision: string,
  query: string,
  goldIds: readonly string[],
): Promise<ScopedIndexProbe> {
  const { rows } = await db.pool.query<{
    query_terms: string;
    indexed_units_in_vault: number;
    strict_matching_units_in_vault: number;
    gold_units_present: number;
    gold_units_matching_strict_query: number;
  }>(
    `with terms as (
       select plainto_tsquery('simple',$2) query_terms
     ), scoped as (
       select u.id,u.lexical_search_vector
         from knowledge_units u
        where u.vault_id=$1
          and u.corpus_revision=$3
          and u.lifecycle='ACTIVE'
          and not u.container_only
     )
     select terms.query_terms::text query_terms,
            (select count(*)::int from scoped u
              where u.lexical_search_vector::text <> '') indexed_units_in_vault,
            (select count(*)::int from scoped u
              where u.lexical_search_vector @@ terms.query_terms)
              strict_matching_units_in_vault,
            (select count(*)::int from scoped u
              where u.id=any($4::uuid[])) gold_units_present,
            (select count(*)::int from scoped u
              where u.id=any($4::uuid[])
                and u.lexical_search_vector @@ terms.query_terms)
              gold_units_matching_strict_query
       from terms`,
    [vaultId, query, revision, [...goldIds]],
  );
  const row = rows[0];
  if (!row) throw new Error("S2_LEXICAL_INDEX_PROBE_EMPTY");
  return {
    queryTerms: row.query_terms,
    indexedUnitsInVault: row.indexed_units_in_vault,
    strictMatchingUnitsInVault: row.strict_matching_units_in_vault,
    goldUnitsPresent: row.gold_units_present,
    goldUnitsMatchingStrictQuery: row.gold_units_matching_strict_query,
  };
}
describe("S2 frozen holdout on real PostgreSQL retrieval", () => {
  it.skipIf(!databaseUrl || !enabled)(
    "measures scoped exact+lexical source-unit recall without implying admission quality",
    async () => {
      const blob = createHash("sha1")
        .update("blob " + datasetBytes.byteLength + "\0")
        .update(datasetBytes)
        .digest("hex");
      expect(blob).toBe(frozenBlobSha1);
      expect(dataset.sourceDocuments).toHaveLength(4);
      expect(dataset.cases).toHaveLength(48);
      const db = new Postgres(databaseUrl!);
      const f = makeFixture();
      const logicalByUuid = new Map(
        [...f.unitIds].map(([key, value]) => [value, key]),
      );
      const observations: S2SpanObservation[] = [];
      const caseDiagnostics = [];
      const controlDiagnostics: Array<{
        query: string;
        sourceId: string;
        returnedHits: number;
      }> = [];
      try {
        await seed(db, f);
        // A zero-recall result is not interpretable unless the fixture is
        // demonstrably queryable using known positive exact/lexical probes.
        for (const control of [
          { sourceId: "marine-beacon", query: "marine-beacon" },
          { sourceId: "marine-beacon", query: "battery" },
          { sourceId: "optical-observatory", query: "camera" },
        ]) {
          const vaultId = f.vaultIds.get(control.sourceId)!;
          const hits = await queryKnowledge(
            db,
            {
              query: control.query,
              spaceId: f.spaceId,
              vaultId,
              vaultIds: [],
              federated: false,
              types: [],
              minimumTrust: "MACHINE_SUPPORTED",
              mode: "SOURCE_BACKED",
              limit: 10,
            },
            { vaultIds: [vaultId], channels: ["exact", "lexical"] },
          );
          expect(
            hits.length,
            "S2 fixture positive control failed: " + control.query,
          ).toBeGreaterThan(0);
          expect(hits.every((hit) => hit.vaultId === vaultId)).toBe(true);
          controlDiagnostics.push({
            sourceId: control.sourceId,
            query: control.query,
            returnedHits: hits.length,
          });
        }
        for (const q of dataset.cases) {
          const vaultId = f.vaultIds.get(q.sourceId)!;
          const indexProbe = await inspectStrictLexicalIndex(
            db,
            vaultId,
            f.revision,
            q.query,
            q.gold.map((gold) => f.unitIds.get(gold.unitId)!),
          );
          expect(indexProbe.indexedUnitsInVault).toBe(6);
          expect(indexProbe.goldUnitsPresent).toBe(q.gold.length);
          const warnings: string[] = [];
          let candidatePoolSize = 0;
          let candidateUnitRanks: string[] | undefined;
          const started = performance.now();
          const hits = await queryKnowledge(
            db,
            {
              query: q.query,
              spaceId: f.spaceId,
              vaultId,
              vaultIds: [],
              federated: false,
              types: [],
              minimumTrust: "MACHINE_SUPPORTED",
              mode: "SOURCE_BACKED",
              limit: 10,
            },
            {
              vaultIds: [vaultId],
              channels: ["exact", "lexical"],
              warningSink: warnings,
              answerabilityCandidateSink: (candidates) => {
                candidatePoolSize = candidates.length;
                candidateUnitRanks = candidates
                  .map((hit) => logicalByUuid.get(hit.unitId ?? ""))
                  .filter((value): value is string => Boolean(value));
              },
            },
          );
          const elapsedMs = performance.now() - started;
          expect(hits.every((hit) => hit.vaultId === vaultId)).toBe(true);
          const returnedUnitRanks = hits
            .map((hit) => logicalByUuid.get(hit.unitId ?? ""))
            .filter((value): value is string => Boolean(value));
          // Recall@k is measured at the post-authorization candidate
          // boundary BEFORE input.limit and before answer admission.
          const rankedUnitIds = candidateUnitRanks ?? returnedUnitRanks;
          const goldUnits = new Set(q.gold.map((item) => item.unitId));
          const rank = rankedUnitIds.findIndex((unitId) =>
            goldUnits.has(unitId),
          );
          observations.push({
            caseId: q.id,
            rankedUnitIds,
            admitted: [],
            admissionMeasured: false,
            elapsedMs,
            degraded: warnings.some((warning) =>
              /(?:ERROR|UNAVAILABLE|TIMEOUT|DEGRADED)/u.test(warning),
            ),
          });
          caseDiagnostics.push({
            caseId: q.id,
            sourceId: q.sourceId,
            candidatePoolSize,
            returnedHits: hits.length,
            unmappedHits: hits.length - returnedUnitRanks.length,
            candidateMappedUnitCount: rankedUnitIds.length,
            presentedMappedUnitCount: returnedUnitRanks.length,
            firstGoldUnitRank: rank < 0 ? null : rank + 1,
            lexicalIndexProbe: indexProbe,
            diagnosis:
              q.answerable && indexProbe.goldUnitsPresent === 0
                ? "GOLD_UNIT_NOT_INGESTED"
                : q.answerable && indexProbe.goldUnitsMatchingStrictQuery === 0
                  ? "STRICT_FULL_TEXT_QUERY_MISSES_GOLD"
                  : q.answerable && rank < 0
                    ? "STRICT_MATCH_PRESENT_BUT_RETRIEVAL_DROPPED_GOLD"
                    : "NO_PROVEN_LEXICAL_MISS",
            warnings,
          });
        }
        const score = scoreS2SpanObservations(dataset, observations);
        expect(score.observedCases).toBe(48);
        expect(score.positiveObserved).toBe(24);
        expect(score.negativeObserved).toBe(24);
        expect(score.admissionObservedCases).toBe(0);
        expect(score.falseAdmissionRate).toBeNull();
        expect(score.exactGoldQuoteCoverage).toBeNull();
        expect(score.finalAnswerCorrectRate).toBeNull();
        expect(score.meanExactInputTokens).toBeNull();
        const output = path.resolve(
          import.meta.dirname,
          "../../../reports/ci/s2-postgres-retrieval-baseline.json",
        );
        const report = {
          schemaVersion: "akp.s2.postgres-retrieval-baseline.v1",
          evidenceLevel: "LIVE_POSTGRES_SCOPED_SQL_ON_SYNTHETIC_PROJECTION",
          headGitSha: process.env.AKP_S2_BRANCH_HEAD_SHA ?? "LOCAL_UNPINNED",
          workflowCheckoutGitSha: process.env.GITHUB_SHA ?? "LOCAL_UNPINNED",
          frozenGitBlobSha1: blob,
          sourceSha256: Object.fromEntries(
            dataset.sourceDocuments.map((source) => [
              source.id,
              digest(
                source.units
                  .map((unit) => unit.id + "\n" + unit.text)
                  .join("\n\n"),
              ),
            ]),
          ),
          method: "CONTROLLED_EXACT_LEXICAL_ONLY",
          recallBoundary: "AUTHORIZED_POST_RERANK_PRE_PRESENTATION_LIMIT",
          presentedHitLimit: 10,
          queryFunction: "apps/api/src/routes/search.ts#queryKnowledge",
          scope: "ONE_FROZEN_SOURCE_VAULT_PER_QUERY",
          fixture: "DIRECT_SYNTHETIC_APPROVED_PROJECTION_NOT_RAW_INGEST",
          independentAdjudication: false,
          semanticAdmissionMeasured: false,
          finalAnswerMeasured: false,
          exactModelTokensMeasured: false,
          gateAccepted: false,
          fixturePositiveControls: controlDiagnostics,
          score,
          caseDiagnostics,
          indexProbeSummary: {
            positiveGoldUnitCount: caseDiagnostics
              .filter((item) => item.caseId.includes("-p"))
              .reduce(
                (total, item) =>
                  total + item.lexicalIndexProbe.goldUnitsPresent,
                0,
              ),
            positiveStrictGoldMatches: caseDiagnostics
              .filter((item) => item.caseId.includes("-p"))
              .reduce(
                (total, item) =>
                  total + item.lexicalIndexProbe.goldUnitsMatchingStrictQuery,
                0,
              ),
            strictQueryNoCandidateCases: caseDiagnostics.filter(
              (item) => item.lexicalIndexProbe.strictMatchingUnitsInVault === 0,
            ).length,
          },
        };
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log(
          "S2_POSTGRES_BASELINE " +
            JSON.stringify({
              observed: score.observedCases,
              recallAt10: score.recallAt10,
              falseAdmissionRate: null,
              gateAccepted: false,
            }),
        );
      } finally {
        try {
          await cleanup(db, f);
        } finally {
          await db.close();
        }
      }
    },
    360_000,
  );
});

/**
 * S2.5 measured shadow comparison: no reranking policy or production default
 * changes. Uses the already-pinned local E5 provider and the same 48 questions.
 * A nearest vector neighbor is NOT evidence admission or answer correctness.
 */
describe("S2 pinned multilingual E5 shadow comparison", () => {
  it.skipIf(!databaseUrl || process.env.AKP_S2_SPAN_MULTILINGUAL !== "1")(
    "compares lexical-only and current hybrid on identical authorized source units",
    async () => {
      const frozenBlob = createHash("sha1")
        .update("blob " + datasetBytes.byteLength + "\0")
        .update(datasetBytes)
        .digest("hex");
      expect(frozenBlob).toBe(frozenBlobSha1);
      const db = new Postgres(databaseUrl!);
      const fixture = makeFixture();
      const logicalByUuid = new Map(
        [...fixture.unitIds].map(([logical, uuid]) => [uuid, logical]),
      );
      const beforeVectorEnabled = process.env.AKP_VECTOR_ENABLED;
      process.env.AKP_VECTOR_ENABLED = "true";
      const adapter = new LocalSemanticEmbeddingAdapter({
        ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
          ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
          : {}),
        localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
        maxBatchSize: 4,
      });
      const configurations = [
        { name: "CONTROLLED_EXACT_LEXICAL", channels: ["exact", "lexical"] },
        {
          name: "EXISTING_E5_MULTILINGUAL_HYBRID",
          channels: ["exact", "lexical", "vector"],
        },
      ] as const;
      const sourceDigests = Object.fromEntries(
        dataset.sourceDocuments.map((source) => [
          source.id,
          digest(
            source.units.map((unit) => unit.id + "\n" + unit.text).join("\n\n"),
          ),
        ]),
      );
      const generationEvidence = [];
      const measuredArms = [];
      const adjudicationCases: Record<string, unknown>[] = [];
      try {
        await seed(db, fixture);
        await adapter.load();
        for (const source of dataset.sourceDocuments) {
          const vaultId = fixture.vaultIds.get(source.id)!;
          const built = await buildEmbeddingIndex(db, {
            spaceId: fixture.spaceId,
            vaultId,
            corpusRevision: fixture.revision,
            provider: adapter,
            activate: true,
            batchSize: 6,
          });
          expect(built.activated).toBe(true);
          expect(built.unitCount).toBe(6);
          expect(built.generation.status).toBe("ACTIVE");
          expect(built.generation.model).toBe(
            LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.model,
          );
          expect(built.generation.modelRevision).toBe(
            LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.modelRevision,
          );
          generationEvidence.push({
            sourceId: source.id,
            generationId: built.generation.generationId,
            model: built.generation.model,
            modelRevision: built.generation.modelRevision,
            dimensions: built.generation.dimensions,
            inputStrategy: built.generation.inputStrategy,
            runtime: built.generation.runtime,
            embeddingCount: built.unitCount,
          });
        }
        const queryEmbeddingService = new QueryEmbeddingService(
          async () => adapter,
        );
        for (const configuration of configurations) {
          const observations: S2SpanObservation[] = [];
          const diagnostics = [];
          for (const question of dataset.cases) {
            const vaultId = fixture.vaultIds.get(question.sourceId)!;
            const warnings: string[] = [];
            const availableChannels = new Set<
              | "context-pack"
              | "exact"
              | "lexical"
              | "vector"
              | "graph"
              | "raw"
              | "code"
            >();
            let candidateRanks: string[] | undefined;
            let candidateHits: readonly SearchHit[] | undefined;
            let candidateCount = 0;
            const start = performance.now();
            const hits = await queryKnowledge(
              db,
              {
                query: question.query,
                spaceId: fixture.spaceId,
                vaultId,
                vaultIds: [],
                federated: false,
                types: [],
                minimumTrust: "MACHINE_SUPPORTED",
                mode: "SOURCE_BACKED",
                limit: 10,
              },
              {
                vaultIds: [vaultId],
                channels: [...configuration.channels],
                queryEmbeddingService,
                warningSink: warnings,
                availableChannelSink: availableChannels,
                answerabilityCandidateSink: (candidates) => {
                  candidateCount = candidates.length;
                  candidateHits = candidates;
                  expect(
                    candidates.every(
                      (candidate) => candidate.vaultId === vaultId,
                    ),
                  ).toBe(true);
                  candidateRanks = candidates.map((candidate) => {
                    const unitId = logicalByUuid.get(candidate.unitId ?? "");
                    if (!unitId) throw new Error("S2_UNMAPPED_CANDIDATE_UNIT");
                    return unitId;
                  });
                },
              },
            );
            const elapsedMs = performance.now() - start;
            expect(hits.every((hit) => hit.vaultId === vaultId)).toBe(true);
            if (configuration.name === "EXISTING_E5_MULTILINGUAL_HYBRID") {
              expect(availableChannels.has("vector")).toBe(true);
            }
            // Reviewer input is derived exclusively from the authorized
            // pre-presentation candidate pool. It contains no gold labels,
            // deterministic-support verdicts, or generated answers.
            if (configuration.name === "EXISTING_E5_MULTILINGUAL_HYBRID") {
              if (!candidateHits) throw new Error("S2_AUTHORIZED_POOL_MISSING");
              const source = dataset.sourceDocuments.find(
                (item) => item.id === question.sourceId,
              );
              if (!source) throw new Error("S2_REVIEW_SOURCE_UNKNOWN");
              const candidates = candidateHits.map((candidate) => {
                const unitId = logicalByUuid.get(candidate.unitId ?? "");
                const unit = source.units.find((item) => item.id === unitId);
                if (!unit) throw new Error("S2_REVIEW_UNIT_OUT_OF_SCOPE");
                const sourceStartOffset = unit.text.indexOf(candidate.excerpt);
                if (sourceStartOffset < 0) {
                  throw new Error("S2_REVIEW_EXCERPT_NOT_SOURCE_BOUND");
                }
                return {
                  candidateKey: digest(
                    question.query + "\0" + question.sourceId + "\0" + unit.id,
                  ),
                  passage: candidate.excerpt,
                  passageSha256: digest(candidate.excerpt),
                  sourceUnitSha256: digest(unit.text),
                  sourceStartOffsetUtf16: sourceStartOffset,
                  sourceEndOffsetUtf16:
                    sourceStartOffset + candidate.excerpt.length,
                  annotation: {
                    verdict: null,
                    quoteStartOffsetUtf16: null,
                    quoteEndOffsetUtf16: null,
                  },
                };
              });
              adjudicationCases.push({
                questionKey: digest(question.query),
                query: question.query,
                candidates: candidates.sort((left, right) =>
                  left.candidateKey.localeCompare(right.candidateKey),
                ),
              });
            }
            const displayed = hits.map((hit) => {
              const unitId = logicalByUuid.get(hit.unitId ?? "");
              if (!unitId) throw new Error("S2_UNMAPPED_DISPLAYED_UNIT");
              return unitId;
            });
            const rankedUnitIds = candidateRanks ?? displayed;
            const goldIds = new Set(question.gold.map((gold) => gold.unitId));
            const firstGoldRank = rankedUnitIds.findIndex((unitId) =>
              goldIds.has(unitId),
            );
            // Experimental deterministic support probe only. This is NOT
            // query-conditioned reader admission or an answer decision.
            const assessed = assessRetrievalAnswerability(
              candidateHits ?? hits,
              question.query,
              {},
              { comparisonHits: candidateHits ?? hits },
            );
            const assessedSupport = assessed.candidateSignals.map((signal) => {
              const unitId = logicalByUuid.get(signal.unitId ?? "");
              if (!unitId) throw new Error("S2_VERIFIER_UNIT_OUT_OF_SCOPE");
              return {
                unitId,
                supported: signal.passageSupport.supported,
                reason: signal.passageSupport.reason,
                queryCoverage: signal.textualSupport.queryCoverage,
                salientCoverage: signal.textualSupport.salientCoverage,
                salientQueryTokens: signal.textualSupport.salientQueryTokens,
                salientOverlapTokens:
                  signal.textualSupport.salientOverlapTokens,
                requiredAnswerCues: signal.passageSupport.requiredAnswerCues,
                matchedAnswerCues: signal.passageSupport.matchedAnswerCues,
                answerCueCoverage: signal.passageSupport.answerCueCoverage,
                boundedAnchorCoverage:
                  signal.passageSupport.boundedAnchorCoverage,
                boundedRelationRoleMatched:
                  signal.passageSupport.boundedRelationRoleMatched,
                claimRelationDiagnostics:
                  signal.passageSupport.claimRelationDiagnostics,
                passageSource: signal.passageSupport.passageSource,
              };
            });
            const supportedUnits = assessedSupport
              .filter((signal) => signal.supported)
              .map((signal) => signal.unitId);
            const verifierProbe = {
              status: "DETERMINISTIC_CANDIDATE_SUPPORT_ONLY",
              supportedCandidateCount: supportedUnits.length,
              supportedGoldUnit: question.answerable
                ? supportedUnits.some((unitId) => goldIds.has(unitId))
                : null,
              anySupportedForNoAnswer: question.answerable
                ? null
                : supportedUnits.length > 0,
              assessmentReason: assessed.reason,
              candidateSignals: assessedSupport,
            };
            observations.push({
              caseId: question.id,
              rankedUnitIds,
              admissionMeasured: false,
              admitted: [],
              elapsedMs,
              degraded: warnings.some((warning) =>
                /(?:ERROR|UNAVAILABLE|TIMEOUT|DEGRADED)/u.test(warning),
              ),
            });
            diagnostics.push({
              caseId: question.id,
              sourceId: question.sourceId,
              language: question.language,
              answerable: question.answerable,
              candidateCount,
              rankedUnitIds,
              presentedUnitIds: displayed,
              firstGoldRank: firstGoldRank < 0 ? null : firstGoldRank + 1,
              verifierProbe,
              availableChannels: [...availableChannels].sort(),
              warnings,
              elapsedMs,
            });
          }
          const score = scoreS2SpanObservations(dataset, observations);
          expect(score.observedCases).toBe(48);
          expect(score.admissionObservedCases).toBe(0);
          expect(score.falseAdmissionRate).toBeNull();
          expect(score.exactGoldQuoteCoverage).toBeNull();
          expect(score.finalAnswerCorrectRate).toBeNull();
          const byLanguage = Object.fromEntries(
            (["en", "es"] as const).map((language) => {
              const langCases = new Set(
                dataset.cases
                  .filter((item) => item.language === language)
                  .map((item) => item.id),
              );
              const langScore = scoreS2SpanObservations(
                {
                  sourceDocuments: dataset.sourceDocuments,
                  cases: dataset.cases.filter((item) => langCases.has(item.id)),
                },
                observations.filter((item) => langCases.has(item.caseId)),
              );
              return [
                language,
                {
                  positiveCount: langScore.positiveObserved,
                  recallAt1: langScore.recallAt1,
                  recallAt5: langScore.recallAt5,
                  recallAt10: langScore.recallAt10,
                },
              ];
            }),
          );
          measuredArms.push({
            configuration: configuration.name,
            channels: configuration.channels,
            score,
            byLanguage,
            deterministicSupportProbe: {
              positiveQuestionsWithGoldCandidateSupported: diagnostics.filter(
                (item) =>
                  item.answerable &&
                  item.verifierProbe.supportedGoldUnit === true,
              ).length,
              positiveQuestionCount: 24,
              negativeQuestionsWithAnyCandidateSupported: diagnostics.filter(
                (item) =>
                  !item.answerable &&
                  item.verifierProbe.anySupportedForNoAnswer === true,
              ).length,
              negativeQuestionCount: 24,
              isProductionAdmittedEvidencePrecision: false,
              isFinalAnswerFalseAdmissionRate: false,
            },
            diagnostics,
          });
        }
        const baseline = measuredArms[0]!;
        const hybrid = measuredArms[1]!;
        // Public, author-constructed fixtures cannot be turned into a
        // blind holdout by withholding labels in this export.
        expect(adjudicationCases).toHaveLength(dataset.cases.length);
        const reviewPacket = {
          schemaVersion: "akp.s2.adjudication-request.v1",
          status: "UNADJUDICATED_PUBLIC_NONBLIND",
          sourceOfCandidates: "AUTHORIZED_E5_QUERY_KNOWLEDGE_CANDIDATE_SINK",
          fixtureProjection: "SYNTHETIC_APPROVED_TEST_ROWS_NOT_RAW_INGEST",
          frozenGitBlobSha1: frozenBlob,
          sourceSha256: sourceDigests,
          branchHeadSha: process.env.AKP_S2_BRANCH_HEAD_SHA ?? "LOCAL_UNPINNED",
          readerDecisionsMeasured: false,
          independentAdjudication: false,
          sourceSpansAdmitted: false,
          goldLabelsIncluded: false,
          deterministicSupportPredictionsIncluded: false,
          candidateOrder: "SORTED_BY_STABLE_KEY_NOT_RETRIEVAL_RANK",
          quoteOffsetConvention: "UTF16_OFFSETS_IN_EXACT_PASSAGE",
          cases: adjudicationCases,
        };
        const reviewPacketFile = path.resolve(
          import.meta.dirname,
          "../../../reports/ci/s2-adjudication-review-packet.json",
        );
        await mkdir(path.dirname(reviewPacketFile), { recursive: true });
        await writeFile(
          reviewPacketFile,
          JSON.stringify(reviewPacket, null, 2) + "\n",
          "utf8",
        );
        const report = {
          schemaVersion: "akp.s2.real-multilingual-shadow.v1",
          evidenceLevel:
            "REAL_PINNED_E5_WITH_POSTGRES_SCOPED_SYNTHETIC_HOLDOUT",
          frozenGitBlobSha1: frozenBlob,
          sourceSha256: sourceDigests,
          branchHeadSha: process.env.AKP_S2_BRANCH_HEAD_SHA ?? "LOCAL_UNPINNED",
          workflowCheckoutSha: process.env.GITHUB_SHA ?? "LOCAL_UNPINNED",
          actor: "SYNTHETIC_TEST_PRINCIPAL",
          queryCountPerConfiguration: dataset.cases.length,
          questionOrder: "FROZEN_FILE_ORDER",
          presentedLimit: 10,
          scope: "ONE_SOURCE_VAULT_PER_QUESTION",
          fixtureProjection: "SYNTHETIC_APPROVED_TEST_ROWS_NOT_RAW_INGEST",
          baselineProfile: "EXACT_PLUS_LEXICAL",
          challengerProfile: "EXISTING_EXACT_PLUS_LEXICAL_PLUS_E5",
          model: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
          generationEvidence,
          arms: measuredArms,
          pairedRecallAt10Delta:
            hybrid.score.recallAt10 === null ||
            baseline.score.recallAt10 === null
              ? null
              : hybrid.score.recallAt10 - baseline.score.recallAt10,
          performanceCaveat:
            "Sequential arms with warm model cache; duration not controlled for query order. No production default change.",
          independentAdjudication: false,
          admissionMeasured: false,
          deterministicSupportProbeMeasured: true,
          generatedAnswerCorrectnessMeasured: false,
          exactModelTokensMeasured: false,
          manualObsidianComparisonMeasured: false,
          gateAccepted: false,
        };
        const file = path.resolve(
          import.meta.dirname,
          "../../../reports/ci/s2-multilingual-shadow-baseline.json",
        );
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log(
          "S2_MULTILINGUAL_SHADOW " +
            JSON.stringify({
              casesPerArm: 48,
              baselineRecallAt10: baseline.score.recallAt10,
              hybridRecallAt10: hybrid.score.recallAt10,
              pairedRecallAt10Delta: report.pairedRecallAt10Delta,
              gateAccepted: false,
            }),
        );
      } finally {
        try {
          await db.pool.query(
            "delete from unit_embeddings where generation_id in " +
              "(select id from embedding_generations where vault_id=any($1::uuid[]))",
            [[...fixture.vaultIds.values()]],
          );
          await db.pool.query(
            "delete from embedding_generations where vault_id=any($1::uuid[])",
            [[...fixture.vaultIds.values()]],
          );
          await cleanup(db, fixture);
        } finally {
          await db.close();
          if (beforeVectorEnabled === undefined) {
            delete process.env.AKP_VECTOR_ENABLED;
          } else {
            process.env.AKP_VECTOR_ENABLED = beforeVectorEnabled;
          }
        }
      }
    },
    360_000,
  );
});

/**
 * S2 route observation: executes the real authenticated /v1/search endpoint,
 * including live retrieval, layered reader admission, and the opt-in shadow
 * sink. This PUBLIC calibration fixture is only an engineering diagnostic.
 * Reader requests contain the query and authorized source units, never gold.
 */
describe("S2 live application admission on disposable PostgreSQL", () => {
  it.skipIf(!databaseUrl || process.env.AKP_S2_LIVE_ROUTE_OBSERVATION !== "1")(
    "records source-rebound reader admissions and full route latency without claiming independent S2 accuracy",
    async () => {
      const frozenBlob = createHash("sha1")
        .update("blob " + datasetBytes.byteLength + "\0")
        .update(datasetBytes)
        .digest("hex");
      expect(frozenBlob).toBe(frozenBlobSha1);
      const expectedMode =
        process.env.AKP_S2_LIVE_ROUTE_EXPECT_MODE ?? "LAYERED";
      expect(["LAYERED", "DETERMINISTIC"]).toContain(expectedMode);
      const { buildServer } = await import("../src/server.js");
      const db = new Postgres(databaseUrl!);
      const fixture = makeFixture();
      const actorId = randomUUID();
      const accessToken = "s2-disposable-" + randomUUID();
      const tokenHash = digest(accessToken);
      const runId = "s2route-" + randomUUID();
      const observed: S2AdmissionShadowObservation[] = [];
      const authorizedSnapshots: S2AuthorizedSourceSnapshot[] = [];
      const readerUsage: Array<{
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }> = [];
      const originalFetch = globalThis.fetch;
      if (expectedMode === "LAYERED") {
        globalThis.fetch = async (input, init) => {
          const response = await originalFetch(input, init);
          try {
            const url = new URL(
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
            );
            if (
              url.hostname === "127.0.0.1" &&
              url.port === "11434" &&
              url.pathname.endsWith("/chat/completions")
            ) {
              const body = (await response.clone().json()) as {
                usage?: {
                  prompt_tokens?: unknown;
                  completion_tokens?: unknown;
                  total_tokens?: unknown;
                };
              };
              const u = body.usage;
              if (
                u &&
                typeof u.prompt_tokens === "number" &&
                typeof u.completion_tokens === "number" &&
                typeof u.total_tokens === "number" &&
                Number.isSafeInteger(u.prompt_tokens) &&
                Number.isSafeInteger(u.completion_tokens) &&
                Number.isSafeInteger(u.total_tokens)
              ) {
                readerUsage.push({
                  promptTokens: u.prompt_tokens,
                  completionTokens: u.completion_tokens,
                  totalTokens: u.total_tokens,
                });
              }
            }
          } catch {
            // Token diagnostics are best effort and never modify admissions.
          }
          return response;
        };
      }
      const app = buildServer({
        s2AdmissionShadowSink: (record) => observed.push(record),
      });
      const maxCases = Number(
        process.env.AKP_S2_LIVE_ROUTE_MAX_CASES ?? dataset.cases.length,
      );
      if (
        !Number.isSafeInteger(maxCases) ||
        maxCases < 1 ||
        maxCases > dataset.cases.length
      ) {
        throw new Error("S2_INVALID_ROUTE_CASE_LIMIT");
      }
      const questions = dataset.cases.slice(0, maxCases);
      const beforeVector = process.env.AKP_VECTOR_ENABLED;
      process.env.AKP_VECTOR_ENABLED = "true";
      const sourceByUnitHash = new Map<
        string,
        { logicalUnitId: string; uuid: string; text: string; sourceId: string }
      >();
      for (const source of dataset.sourceDocuments) {
        for (const unit of source.units) {
          const uuid = fixture.unitIds.get(unit.id)!;
          sourceByUnitHash.set(digest(uuid), {
            logicalUnitId: unit.id,
            uuid,
            text: unit.text,
            sourceId: source.id,
          });
        }
      }
      const observations: S2SpanObservation[] = [];
      const diagnostics: Array<{
        caseId: string;
        language: "en" | "es";
        answerable: boolean;
        admissionMode: string;
        candidateCount: number;
        admittedCount: number;
        reboundCount: number;
        admittedWithoutSourceSpan: number;
        requestElapsedMs: number;
        admissionElapsedMs: number;
        readerCalls: number;
        readerPromptTokens: number;
        readerCompletionTokens: number;
        reason: string;
        warnings: string[];
      }> = [];
      let seeded = false;
      try {
        await seed(db, fixture);
        seeded = true;
        await db.pool.query(
          "insert into users(id,email,display_name) values($1,$2,'S2 disposable reader')",
          [actorId, actorId + "@example.test"],
        );
        await db.pool.query(
          "insert into memberships(user_id,space_id,role,path_prefix) values($1,$2,'VIEWER',null)",
          [actorId, fixture.spaceId],
        );
        for (const vaultId of fixture.vaultIds.values()) {
          await db.pool.query(
            "insert into vault_memberships(user_id,vault_id,role,path_prefix,permissions) " +
              "values($1,$2,'VIEWER',null,'[\"knowledge:read\",\"source:read\"]'::jsonb)",
            [actorId, vaultId],
          );
        }
        await db.pool.query(
          "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,'S2 disposable',$3::jsonb)",
          [
            actorId,
            tokenHash,
            JSON.stringify({
              spaces: [
                {
                  spaceId: fixture.spaceId,
                  pathPrefix: null,
                  permissions: ["knowledge:read", "source:read"],
                },
              ],
            }),
          ],
        );
        const adapter = new LocalSemanticEmbeddingAdapter({
          ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
            ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
            : {}),
          localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
          maxBatchSize: 4,
        });
        await adapter.load();
        for (const vaultId of fixture.vaultIds.values()) {
          const built = await buildEmbeddingIndex(db, {
            spaceId: fixture.spaceId,
            vaultId,
            corpusRevision: fixture.revision,
            provider: adapter,
            activate: true,
            batchSize: 6,
          });
          expect(built.activated).toBe(true);
          expect(built.unitCount).toBe(6);
        }
        const documentIds = new Map<string, string>();
        const documents = await db.pool.query<{
          vault_id: string;
          id: string;
        }>("select vault_id,id from knowledge_documents where space_id=$1", [
          fixture.spaceId,
        ]);
        for (const row of documents.rows) {
          documentIds.set(row.vault_id, row.id);
        }
        for (const question of questions) {
          const vaultId = fixture.vaultIds.get(question.sourceId)!;
          const countBefore = observed.length;
          const readerUsageBefore = readerUsage.length;
          const started = performance.now();
          const response = await app.inject({
            method: "POST",
            url: "/v1/search",
            headers: { authorization: "Bearer " + accessToken },
            payload: {
              query: question.query,
              spaceId: fixture.spaceId,
              vaultId,
              vaultIds: [],
              federated: false,
              intent: "CONCEPTUAL",
              types: [],
              minimumTrust: "MACHINE_SUPPORTED",
              mode: "SOURCE_BACKED",
              limit: 10,
            },
          });
          const requestElapsedMs = performance.now() - started;
          expect(response.statusCode, response.body).toBe(200);
          expect(observed.length - countBefore).toBe(1);
          const record = observed[countBefore]!;
          expect(record.surface).toBe("search");
          expect(record.admissionMode).toBe(expectedMode);
          expect(record.scopeSha256).toBe(digest(vaultId));
          expect(record.querySha256).toBe(digest(question.query));
          const snapshot = {
            query: question.query,
            authorizedVaultIds: [vaultId],
            candidates: record.candidates.map((candidate) => {
              const unit = candidate.unitIdSha256
                ? sourceByUnitHash.get(candidate.unitIdSha256)
                : undefined;
              if (!unit || unit.sourceId !== question.sourceId) {
                throw new Error("S2_LIVE_ROUTE_UNIT_OUT_OF_SCOPE");
              }
              const documentId = documentIds.get(vaultId);
              if (!documentId)
                throw new Error("S2_LIVE_ROUTE_DOCUMENT_MISSING");
              // All frozen source units are short, single-paragraph units.
              // Refuse to manufacture an excerpt if retrieval did not use
              // exactly those bytes: a mismatch invalidates this run.
              if (digest(unit.text) !== candidate.excerptSha256) {
                throw new Error("S2_LIVE_ROUTE_EXCERPT_NOT_SOURCE_EXACT");
              }
              return {
                vaultId,
                documentId,
                unitId: unit.uuid,
                revision: fixture.revision,
                excerpt: unit.text,
                sourceUnitText: unit.text,
                sourceUnitSha256: digest(unit.text),
              };
            }),
          };
          authorizedSnapshots.push(snapshot);
          const rebound = rebindS2AdmissionToSource(record, snapshot);
          const admitted = rebound.results.flatMap((item) => {
            if (item.status !== "SOURCE_SPAN_REBOUND" || !item.sourceSpan) {
              return [];
            }
            const indexed = snapshot.candidates.find(
              (candidate) =>
                digest(candidate.documentId + ":" + candidate.unitId) ===
                item.candidateKeySha256,
            );
            const unit = indexed
              ? sourceByUnitHash.get(digest(indexed.unitId!))
              : undefined;
            if (!unit) throw new Error("S2_LIVE_ROUTE_REBOUND_UNIT_MISSING");
            return [
              {
                unitId: unit.logicalUnitId,
                startOffset: item.sourceSpan.startOffsetUtf16,
                endOffset: item.sourceSpan.endOffsetUtf16,
                quote: unit.text.slice(
                  item.sourceSpan.startOffsetUtf16,
                  item.sourceSpan.endOffsetUtf16,
                ),
              },
            ];
          });
          const rankedUnitIds = record.candidates.map((candidate) => {
            const mapped = candidate.unitIdSha256
              ? sourceByUnitHash.get(candidate.unitIdSha256)
              : undefined;
            if (!mapped) throw new Error("S2_LIVE_ROUTE_UNKNOWN_RANKED_UNIT");
            return mapped.logicalUnitId;
          });
          const warnings: string[] = Array.isArray(response.json().warnings)
            ? response.json().warnings
            : [];
          observations.push({
            caseId: question.id,
            rankedUnitIds,
            admitted,
            elapsedMs: requestElapsedMs,
            degraded: warnings.some((w) =>
              /(?:ERROR|UNAVAILABLE|TIMEOUT|DEGRADED)/u.test(w),
            ),
          });
          diagnostics.push({
            caseId: question.id,
            language: question.language,
            answerable: question.answerable,
            admissionMode: record.admissionMode,
            candidateCount: record.candidateCount,
            admittedCount: record.admittedCandidateCount,
            reboundCount: rebound.admittedWithSourceReboundSpan,
            admittedWithoutSourceSpan: rebound.admittedWithoutSourceReboundSpan,
            requestElapsedMs,
            admissionElapsedMs: record.admissionElapsedMs,
            readerCalls: readerUsage.length - readerUsageBefore,
            readerPromptTokens: readerUsage
              .slice(readerUsageBefore)
              .reduce((sum, value) => sum + value.promptTokens, 0),
            readerCompletionTokens: readerUsage
              .slice(readerUsageBefore)
              .reduce((sum, value) => sum + value.completionTokens, 0),
            reason: record.reason,
            warnings: warnings.filter((w) => /^[A-Z_0-9:-]+$/u.test(w)),
          });
        }
        const score = scoreS2SpanObservations(
          {
            sourceDocuments: dataset.sourceDocuments,
            cases: questions,
          },
          observations,
        );
        const p95 = (values: number[]) =>
          [...values].sort((a, b) => a - b)[
            Math.ceil(values.length * 0.95) - 1
          ] ?? null;
        const byLanguage = Object.fromEntries(
          (["en", "es"] as const).map((language) => {
            const rows = diagnostics.filter((row) => row.language === language);
            const negatives = rows.filter((row) => !row.answerable);
            const positives = rows.filter((row) => row.answerable);
            return [
              language,
              {
                cases: rows.length,
                answerable: positives.length,
                negative: negatives.length,
                positivesWithAdmission: positives.filter(
                  (row) => row.admittedCount > 0,
                ).length,
                negativesWithAdmission: negatives.filter(
                  (row) => row.admittedCount > 0,
                ).length,
                fullRequestP95Ms: p95(rows.map((row) => row.requestElapsedMs)),
              },
            ];
          }),
        );
        const rawNegativeAdmissions = diagnostics.filter(
          (row) => !row.answerable && row.admittedCount > 0,
        ).length;
        const negativeCount = diagnostics.filter(
          (row) => !row.answerable,
        ).length;
        const report = {
          schemaVersion: "akp.s2.live-route-observation.v1",
          evidenceLevel:
            expectedMode === "LAYERED"
              ? "AUTHENTICATED_API_REAL_MODEL_ON_PUBLIC_AUTHOR_CRAFTED_SYNTHETIC_CALIBRATION"
              : "AUTHENTICATED_API_DETERMINISTIC_ON_PUBLIC_AUTHOR_CRAFTED_SYNTHETIC_CALIBRATION",
          executedCommitSha:
            process.env.AKP_S2_BRANCH_HEAD_SHA ?? "LOCAL_UNPINNED",
          frozenSourceBlobSha1: frozenBlob,
          readerModel:
            expectedMode === "LAYERED"
              ? (process.env.AKP_EVIDENCE_READER_MODEL ?? "UNPINNED")
              : null,
          providerMode: expectedMode,
          corpusQuestions: dataset.cases.length,
          questionsRun: questions.length,
          runId,
          // The generic span scorer sees only rebound quotations; the
          // deterministic gate can admit passages without any reader span.
          // Thus only rawApplicationAdmissions below is authoritative for
          // the observed query-level false admission numerator.
          score: { ...score, falseAdmissionRate: null },
          rawApplicationAdmissions: {
            admittedCount: diagnostics.reduce(
              (sum, row) => sum + row.admittedCount,
              0,
            ),
            negativesWithAdmission: rawNegativeAdmissions,
            negativeCount,
            falseAdmissionRate:
              negativeCount > 0 ? rawNegativeAdmissions / negativeCount : null,
            exactSourceReboundCount: diagnostics.reduce(
              (sum, row) => sum + row.reboundCount,
              0,
            ),
            admittedWithoutSourceSpan: diagnostics.reduce(
              (sum, row) => sum + row.admittedWithoutSourceSpan,
              0,
            ),
          },
          fullRequestP95Ms: p95(diagnostics.map((row) => row.requestElapsedMs)),
          readerTokenUsage: {
            providerReported: expectedMode === "LAYERED",
            observedCalls: readerUsage.length,
            promptTokens: readerUsage.reduce(
              (sum, item) => sum + item.promptTokens,
              0,
            ),
            completionTokens: readerUsage.reduce(
              (sum, item) => sum + item.completionTokens,
              0,
            ),
            totalTokens: readerUsage.reduce(
              (sum, item) => sum + item.totalTokens,
              0,
            ),
            doesNotMeasureFinalAnswerTokensOrSavings: true,
          },
          byLanguage,
          diagnostics,
          independentHoldout: false,
          independentAdjudication: false,
          fullGeneratedAnswersMeasured: false,
          pairedManualObsidianMeasured: false,
          exactModelTokensMeasured: false,
          gateAccepted: false,
        };
        const file = path.resolve(
          import.meta.dirname,
          "../../../reports/ci/s2-live-route-" +
            expectedMode.toLowerCase() +
            "-observation.json",
        );
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(report, null, 2) + "\n");
        const traceDirectory = path.dirname(file);
        const modeKey = expectedMode.toLowerCase();
        const admissionRun = {
          schemaVersion: "akp.s2.observed-admission-run.v1",
          runId,
          executedCommitSha:
            process.env.AKP_S2_BRANCH_HEAD_SHA ?? "LOCAL_UNPINNED",
          observations: observed,
        };
        const sourceBatch = {
          schemaVersion: "akp.s2.authorized-snapshot-batch.v1",
          runId,
          frozenSourceManifestSha256: digest(datasetBytes.toString("utf8")),
          snapshots: authorizedSnapshots,
        };
        const admissionFile = path.join(
          traceDirectory,
          `s2-live-route-${modeKey}-observations.json`,
        );
        const sourceFile = path.join(
          traceDirectory,
          `s2-live-route-${modeKey}-authorized-sources.json`,
        );
        await writeFile(
          admissionFile,
          JSON.stringify(admissionRun, null, 2) + "\n",
        );
        await writeFile(
          sourceFile,
          JSON.stringify(sourceBatch, null, 2) + "\n",
        );
        console.log(
          "S2_LIVE_ROUTE " +
            JSON.stringify({
              questions: questions.length,
              rawAdmissionFalseRate:
                report.rawApplicationAdmissions.falseAdmissionRate,
              sourceRebound:
                report.rawApplicationAdmissions.exactSourceReboundCount,
              fullRequestP95Ms: report.fullRequestP95Ms,
              replayableTraceRecords: observed.length,
              replayableSourceSnapshots: authorizedSnapshots.length,
              gateAccepted: false,
            }),
        );
      } finally {
        globalThis.fetch = originalFetch;
        await app.close();
        await db.pool.query("delete from api_tokens where user_id=$1", [
          actorId,
        ]);
        await db.pool.query("delete from vault_memberships where user_id=$1", [
          actorId,
        ]);
        await db.pool.query("delete from memberships where user_id=$1", [
          actorId,
        ]);
        await db.pool.query("delete from users where id=$1", [actorId]);
        if (seeded) {
          const vaults = [...fixture.vaultIds.values()];
          await db.pool.query(
            "delete from unit_embeddings where generation_id in " +
              "(select id from embedding_generations where vault_id=any($1::uuid[]))",
            [vaults],
          );
          await db.pool.query(
            "delete from embedding_generations where vault_id=any($1::uuid[])",
            [vaults],
          );
          await cleanup(db, fixture);
        }
        await db.close();
        if (beforeVector === undefined) {
          delete process.env.AKP_VECTOR_ENABLED;
        } else {
          process.env.AKP_VECTOR_ENABLED = beforeVector;
        }
      }
    },
    1_200_000,
  );
});
