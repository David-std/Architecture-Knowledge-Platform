import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { buildEmbeddingIndex } from "@akp/indexing";
import {
  assessRetrievalAnswerability,
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  MULTILINGUAL_E5_SMALL_DIMENSIONS,
  LocalSemanticEmbeddingAdapter,
  QueryEmbeddingService,
  type ActiveEmbeddingGenerationDescriptor,
} from "@akp/retrieval";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;
const realModelTestsEnabled =
  process.env.AKP_RUN_REAL_MODEL_TESTS === "1" ||
  process.env.AKP_RUN_REAL_SEMANTIC_TEST === "1";

interface ScopeFixture {
  organizationId: string;
  spaceId: string;
  vaultIds: string[];
  corpusRevision: string;
}

interface DocumentFixture {
  id: string;
  unitId: string;
  vaultId: string;
  externalId: string;
  path: string;
  title: string;
  body: string;
  contentHash: string;
}

function documentFixture(
  vaultId: string,
  path: string,
  title: string,
  body: string,
  externalId = `REAL-SEMANTIC-${randomUUID().slice(0, 8)}`,
): DocumentFixture {
  return {
    id: randomUUID(),
    unitId: randomUUID(),
    vaultId,
    externalId,
    path,
    title,
    body,
    contentHash: createHash("sha256").update(body).digest("hex"),
  };
}

async function seedScope(
  db: Postgres,
  fixture: ScopeFixture,
  documents: readonly DocumentFixture[],
): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,$3)`,
    [
      fixture.organizationId,
      `real-semantic-${fixture.organizationId.slice(0, 8)}`,
      "Real semantic retrieval test organization",
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `real-semantic-${fixture.spaceId.slice(0, 8)}`,
      "Real semantic retrieval test space",
      `C:/akp/real-semantic/${fixture.spaceId}`,
    ],
  );

  for (const [index, vaultId] of fixture.vaultIds.entries()) {
    const vaultKey = `real-semantic-${vaultId.slice(0, 8)}`;
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        fixture.spaceId,
        `C:/akp/real-semantic/${vaultId}`,
        `Real semantic vault ${index + 1}`,
        fixture.corpusRevision,
        vaultKey,
      ],
    );
    await db.pool.query(
      `insert into vault_index_revisions(
         space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
         graph_revision,context_pack_revision,status,warnings
       ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
      [fixture.spaceId, vaultId, fixture.corpusRevision],
    );
  }

  for (const document of documents) {
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
         content_hash,token_estimate,raw_links
       ) values($1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED',
                $7,$8,$9::jsonb,$10,'concept',$11,$12,$13::jsonb)`,
      [
        document.id,
        fixture.spaceId,
        document.vaultId,
        document.path,
        document.externalId,
        document.title,
        fixture.corpusRevision,
        document.body,
        JSON.stringify({
          id: document.externalId,
          title: document.title,
          knowledge_layer: "concept",
        }),
        [],
        document.contentHash,
        document.body.split(/\s+/u).length,
        JSON.stringify([]),
      ],
    );
    await db.pool.query(
      `insert into knowledge_units(
         id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
         content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
         source_ids,token_estimate,parent_unit_id,permissions,locator,
         structural_order,container_only,embedding_eligible
       ) values($1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8,$9,$9,'ACTIVE',
                'HUMAN_REVIEWED',$10,$11,null,$12::jsonb,$13::jsonb,$14,false,true)`,
      [
        document.unitId,
        document.id,
        fixture.spaceId,
        document.vaultId,
        `paragraph-${document.unitId.slice(0, 8)}`,
        [],
        document.body,
        document.contentHash,
        fixture.corpusRevision,
        [],
        document.body.split(/\s+/u).length,
        JSON.stringify({}),
        JSON.stringify({ path: document.path }),
        1,
      ],
    );
  }
}

async function activateGeneration(
  db: Postgres,
  adapter: LocalSemanticEmbeddingAdapter,
  fixture: ScopeFixture,
  vaultId: string,
  documents: readonly DocumentFixture[],
): Promise<ActiveEmbeddingGenerationDescriptor> {
  const built = await buildEmbeddingIndex(db, {
    spaceId: fixture.spaceId,
    vaultId,
    corpusRevision: fixture.corpusRevision,
    provider: adapter,
    activate: true,
    batchSize: 2,
  });
  expect(built.unitCount).toBe(documents.length);
  expect(built.embeddingsCreated).toBe(documents.length);
  expect(built.activated).toBe(true);
  const active = built.generation;
  expect(active.status).toBe("ACTIVE");
  return {
    generationId: active.generationId,
    spaceId: active.spaceId,
    vaultId: active.vaultId,
    corpusRevision: active.corpusRevision,
    provider: active.provider,
    model: active.model,
    modelRevision: active.modelRevision,
    dimensions: active.dimensions,
    normalization: active.normalization,
    inputStrategy: active.inputStrategy,
    configurationVersion: active.configurationVersion,
    runtime: active.runtime,
    configurationHash: active.configurationHash,
  };
}

async function cleanupFixture(
  db: Postgres,
  fixture: ScopeFixture,
): Promise<void> {
  await db.pool.query(
    `delete from unit_embeddings
      where generation_id in (
        select id from embedding_generations where vault_id=any($1::uuid[])
      )`,
    [fixture.vaultIds],
  );
  await db.pool.query(
    "delete from embedding_generations where vault_id=any($1::uuid[])",
    [fixture.vaultIds],
  );
  await db.pool.query(
    "delete from knowledge_units where vault_id=any($1::uuid[])",
    [fixture.vaultIds],
  );
  await db.pool.query(
    "delete from knowledge_documents where vault_id=any($1::uuid[])",
    [fixture.vaultIds],
  );
  await db.pool.query(
    "delete from vault_index_revisions where vault_id=any($1::uuid[])",
    [fixture.vaultIds],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    fixture.vaultIds,
  ]);
  await db.pool.query("delete from spaces where id=$1", [fixture.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
}

const integration = describe.skipIf(!databaseUrl || !realModelTestsEnabled);

integration("real multilingual semantic retrieval", () => {
  it(
    "persists and activates 384d E5 vectors, ranks cross-language candidates, and enforces vault scope",
    async () => {
      if (!databaseUrl) throw new Error("DATABASE_URL is required");

      const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
      process.env.AKP_VECTOR_ENABLED = "true";
      const fixture: ScopeFixture = {
        organizationId: randomUUID(),
        spaceId: randomUUID(),
        vaultIds: [randomUUID(), randomUUID()],
        corpusRevision: `real-semantic-${randomUUID()}`,
      };
      const targetVaultId = fixture.vaultIds[0] as string;
      const foreignVaultId = fixture.vaultIds[1] as string;
      const targetRelevant = documentFixture(
        targetVaultId,
        "real-semantic/enrollment.md",
        "University enrollment withdrawal",
        "To cancel university enrollment before the deadline, the student must submit a withdrawal request through the registrar.",
      );
      const targetRelevantPeer = documentFixture(
        targetVaultId,
        "real-semantic/registration-cancellation.md",
        "Registration cancellation procedure",
        "To withdraw university enrollment before the deadline, a student files a cancellation request with the academic records office.",
      );
      const targetRelevantThird = documentFixture(
        targetVaultId,
        "real-semantic/withdrawal-deadline.md",
        "Withdrawal before the cutoff",
        "Before the registration cutoff, a learner files a withdrawal form with student records so the enrollment can be cancelled.",
      );
      const targetDistractor = documentFixture(
        targetVaultId,
        "real-semantic/pasta.md",
        "Receta de pasta de verano",
        "Esta receta combina tomates, albahaca, ajo y aceite de oliva para preparar una pasta fresca de verano.",
      );
      const targetDistractorTwo = documentFixture(
        targetVaultId,
        "real-semantic/cache.md",
        "Application cache retention",
        "Cached responses use bounded retention and are refreshed after their configured expiration window.",
      );
      const targetDistractorThree = documentFixture(
        targetVaultId,
        "real-semantic/observability.md",
        "Runtime telemetry",
        "Application traces and metrics are exported to the configured observability backend.",
      );
      const foreignCandidate = documentFixture(
        foreignVaultId,
        targetRelevant.path,
        targetRelevant.title,
        targetRelevant.body,
        targetRelevant.externalId,
      );
      const targetDocuments = [
        targetRelevant,
        targetRelevantPeer,
        targetRelevantThird,
        targetDistractor,
        targetDistractorTwo,
        targetDistractorThree,
      ];
      const allDocuments = [...targetDocuments, foreignCandidate];
      const db = new Postgres(databaseUrl);
      const adapter = new LocalSemanticEmbeddingAdapter({
        ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
          ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
          : {}),
        localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
        maxBatchSize: 2,
      });

      try {
        await seedScope(db, fixture, allDocuments);
        // Loading and embedding here are deliberately real model calls. The
        // adapter pins multilingual-e5-small to its Hub revision and model_O4.
        await adapter.load();
        const targetGeneration = await activateGeneration(
          db,
          adapter,
          fixture,
          targetVaultId,
          targetDocuments,
        );
        const foreignGeneration = await activateGeneration(
          db,
          adapter,
          fixture,
          foreignVaultId,
          [foreignCandidate],
        );

        const persisted = await db.pool.query<{
          status: string;
          provider: string;
          model: string;
          model_revision: string;
          dimensions: number;
          input_strategy: string;
          embedding_count: number;
          embedding_dimensions: number;
        }>(
          `select g.status,g.provider,g.model,g.model_revision,g.dimensions,
                  g.input_strategy,count(e.id)::int embedding_count,
                  min(e.embedding_dimensions)::int embedding_dimensions
             from embedding_generations g
             left join unit_embeddings e on e.generation_id=g.id
            where g.id=$1
            group by g.id`,
          [targetGeneration.generationId],
        );
        expect(persisted.rows[0]).toMatchObject({
          status: "ACTIVE",
          provider: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.provider,
          model: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.model,
          model_revision: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.modelRevision,
          dimensions: MULTILINGUAL_E5_SMALL_DIMENSIONS,
          input_strategy: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.inputStrategy,
          embedding_count: targetDocuments.length,
          embedding_dimensions: MULTILINGUAL_E5_SMALL_DIMENSIONS,
        });
        expect(targetGeneration.runtime).toContain(
          '"modelFileName":"model_O4"',
        );
        expect(targetGeneration.runtime).toContain('"subfolder":"onnx"');

        const resolverCalls: ActiveEmbeddingGenerationDescriptor[] = [];
        const queryService = new QueryEmbeddingService(async (generation) => {
          resolverCalls.push(generation);
          return adapter;
        });
        const query =
          "¿Cómo puede un estudiante cancelar su matrícula universitaria antes de la fecha límite?";
        let targetComparisonPool:
          Parameters<typeof assessRetrievalAnswerability>[0] | undefined;
        const targetRetrievalStarted = performance.now();
        const targetHits = await queryKnowledge(
          db,
          {
            query,
            spaceId: fixture.spaceId,
            vaultId: targetVaultId,
            vaultIds: [],
            federated: false,
            types: [],
            minimumTrust: "MACHINE_SUPPORTED",
            mode: "SOURCE_BACKED",
            limit: 5,
          },
          {
            vaultIds: [targetVaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
            answerabilityCandidateSink: (candidates) => {
              targetComparisonPool = candidates;
            },
          },
        );
        const targetRetrievalLatencyMs =
          performance.now() - targetRetrievalStarted;

        expect(targetHits).toHaveLength(5);
        expect(targetHits[0]?.documentId).toBe(targetRelevant.id);
        expect(targetHits.map((hit) => hit.documentId)).toContain(
          targetRelevantPeer.id,
        );
        expect(targetHits.map((hit) => hit.documentId)).toContain(
          targetRelevantThird.id,
        );
        expect(targetHits[0]?.score).toBeGreaterThan(targetHits[1]?.score ?? 0);
        expect(targetHits.every((hit) => hit.vaultId === targetVaultId)).toBe(
          true,
        );
        expect(targetHits.map((hit) => hit.documentId)).not.toContain(
          foreignCandidate.id,
        );
        expect(resolverCalls).toHaveLength(1);
        expect(resolverCalls[0]).toMatchObject({
          generationId: targetGeneration.generationId,
          spaceId: fixture.spaceId,
          vaultId: targetVaultId,
          corpusRevision: fixture.corpusRevision,
          provider: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.provider,
          model: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.model,
          modelRevision: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.modelRevision,
          dimensions: MULTILINGUAL_E5_SMALL_DIMENSIONS,
          normalization: "l2",
          inputStrategy: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.inputStrategy,
        });

        let limitedComparisonPool:
          Parameters<typeof assessRetrievalAnswerability>[0] | undefined;
        const limitedHits = await queryKnowledge(
          db,
          {
            query,
            spaceId: fixture.spaceId,
            vaultId: targetVaultId,
            vaultIds: [],
            federated: false,
            types: [],
            minimumTrust: "MACHINE_SUPPORTED",
            mode: "SOURCE_BACKED",
            limit: 1,
          },
          {
            vaultIds: [targetVaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
            answerabilityCandidateSink: (candidates) => {
              limitedComparisonPool = candidates;
            },
          },
        );
        expect(limitedHits).toHaveLength(1);
        expect(limitedHits[0]?.documentId).toBe(targetRelevant.id);
        expect(limitedComparisonPool?.length).toBeGreaterThanOrEqual(3);
        const limitedAnswerabilityPool = limitedComparisonPool ?? limitedHits;
        const limitedVerificationStarted = performance.now();
        const limitedAssessment = assessRetrievalAnswerability(
          limitedAnswerabilityPool,
          query,
          {},
          { comparisonHits: limitedAnswerabilityPool },
        );
        const limitedVerificationLatencyMs =
          performance.now() - limitedVerificationStarted;

        const unsupportedQuery =
          "What guaranteed 24/7 telephone support SLA is included for premium customers?";
        let unsupportedComparisonPool:
          Parameters<typeof assessRetrievalAnswerability>[0] | undefined;
        const unsupportedHits = await queryKnowledge(
          db,
          {
            query: unsupportedQuery,
            spaceId: fixture.spaceId,
            vaultId: targetVaultId,
            vaultIds: [],
            federated: false,
            types: [],
            minimumTrust: "MACHINE_SUPPORTED",
            mode: "SOURCE_BACKED",
            limit: 5,
          },
          {
            vaultIds: [targetVaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
            answerabilityCandidateSink: (candidates) => {
              unsupportedComparisonPool = candidates;
            },
          },
        );
        const unsupportedAnswerabilityPool =
          unsupportedComparisonPool ?? unsupportedHits;
        const unsupportedVerificationStarted = performance.now();
        const unsupportedAssessment = assessRetrievalAnswerability(
          unsupportedAnswerabilityPool,
          unsupportedQuery,
          {},
          { comparisonHits: unsupportedAnswerabilityPool },
        );
        const unsupportedVerificationLatencyMs =
          performance.now() - unsupportedVerificationStarted;
        const evaluateCase = async (caseQuery: string) => {
          let comparisonPool:
            Parameters<typeof assessRetrievalAnswerability>[0] | undefined;
          const retrievalStarted = performance.now();
          const rawHits = await queryKnowledge(
            db,
            {
              query: caseQuery,
              spaceId: fixture.spaceId,
              vaultId: targetVaultId,
              vaultIds: [],
              federated: false,
              types: [],
              minimumTrust: "MACHINE_SUPPORTED",
              mode: "SOURCE_BACKED",
              limit: 5,
            },
            {
              vaultIds: [targetVaultId],
              channels: ["vector"],
              queryEmbeddingService: queryService,
              answerabilityCandidateSink: (candidates) => {
                comparisonPool = candidates;
              },
            },
          );
          const retrievalLatencyMs = performance.now() - retrievalStarted;
          const answerabilityPool = comparisonPool ?? rawHits;
          const verificationStarted = performance.now();
          const assessment = assessRetrievalAnswerability(
            answerabilityPool,
            caseQuery,
            {},
            { comparisonHits: answerabilityPool },
          );
          const verificationLatencyMs = performance.now() - verificationStarted;
          return {
            rawHits,
            assessment,
            retrievalLatencyMs,
            verificationLatencyMs,
          };
        };

        const englishCase = await evaluateCase(
          "How should a student withdraw registration before the deadline?",
        );
        const semanticNeighborCase = await evaluateCase(
          "What exact tuition refund percentage is guaranteed after enrollment withdrawal?",
        );
        const targetAssessmentStarted = performance.now();
        const targetAnswerabilityPool = targetComparisonPool ?? targetHits;
        const targetAssessment = assessRetrievalAnswerability(
          targetAnswerabilityPool,
          query,
          {},
          { comparisonHits: targetAnswerabilityPool },
        );
        const targetVerificationLatencyMs =
          performance.now() - targetAssessmentStarted;

        const goldDocumentIds = [
          targetRelevant.id,
          targetRelevantPeer.id,
          targetRelevantThird.id,
        ];
        const rankedDocumentIds = targetHits.map((hit) => hit.documentId);
        const retrievedGold = goldDocumentIds.filter((documentId) =>
          rankedDocumentIds.slice(0, 5).includes(documentId),
        );
        const englishRankedDocumentIds = englishCase.rawHits.map(
          (hit) => hit.documentId,
        );
        const englishRetrievedGold = goldDocumentIds.filter((documentId) =>
          englishRankedDocumentIds.slice(0, 5).includes(documentId),
        );
        const correctSourceRank = Math.min(
          ...goldDocumentIds
            .map((documentId) => rankedDocumentIds.indexOf(documentId))
            .filter((index) => index >= 0)
            .map((index) => index + 1),
        );
        const legacyPureVectorSupport = (
          assessment: ReturnType<typeof assessRetrievalAnswerability>,
        ) =>
          assessment.vectorMargin !== null && assessment.vectorMargin >= 0.03;
        const cases = [
          {
            id: "cross-language-withdrawal",
            expectedSupport: true,
            goldDocumentIds,
            rawHits: targetHits,
            assessment: targetAssessment,
            retrievalLatencyMs: targetRetrievalLatencyMs,
            verificationLatencyMs: targetVerificationLatencyMs,
          },
          {
            id: "english-withdrawal-paraphrase",
            expectedSupport: true,
            goldDocumentIds,
            rawHits: englishCase.rawHits,
            assessment: englishCase.assessment,
            retrievalLatencyMs: englishCase.retrievalLatencyMs,
            verificationLatencyMs: englishCase.verificationLatencyMs,
          },
          {
            id: "unrelated-support-sla",
            expectedSupport: false,
            goldDocumentIds: [] as string[],
            rawHits: unsupportedHits,
            assessment: unsupportedAssessment,
            retrievalLatencyMs: 0,
            verificationLatencyMs: unsupportedVerificationLatencyMs,
          },
          {
            id: "semantic-neighbor-without-refund-answer",
            expectedSupport: false,
            goldDocumentIds: [] as string[],
            rawHits: semanticNeighborCase.rawHits,
            assessment: semanticNeighborCase.assessment,
            retrievalLatencyMs: semanticNeighborCase.retrievalLatencyMs,
            verificationLatencyMs: semanticNeighborCase.verificationLatencyMs,
          },
        ];
        const answerableCases = cases.filter((entry) => entry.expectedSupport);
        const negativeCases = cases.filter((entry) => !entry.expectedSupport);
        const correctRetrievedSourceIds = answerableCases.flatMap((entry) =>
          entry.goldDocumentIds.filter((documentId) =>
            entry.rawHits
              .slice(0, 5)
              .some((hit) => hit.documentId === documentId),
          ),
        );
        const correctAcceptedSourceIds = answerableCases.flatMap((entry) =>
          entry.goldDocumentIds.filter(
            (documentId) =>
              entry.rawHits
                .slice(0, 5)
                .some((hit) => hit.documentId === documentId) &&
              entry.assessment.supportedDocumentIds.includes(documentId),
          ),
        );
        const literalFailures = cases
          .filter(
            (entry) => entry.assessment.supported !== entry.expectedSupport,
          )
          .map(
            (entry) =>
              `${entry.id}: expected ${entry.expectedSupport ? "SUPPORTED" : "ABSTAIN"} but got ${entry.assessment.supported ? "SUPPORTED" : "ABSTAIN"} (${entry.assessment.reason})`,
          );
        const semanticMetrics = {
          schemaVersion: 2,
          evidenceBoundary:
            "Generic synthetic multilingual E5 fixture only; not evidence of corpus-general precision.",
          cases: {
            answerable: answerableCases.length,
            unsupported: negativeCases.length,
          },
          retrievalBeforeFilter: {
            recallAt5:
              (retrievedGold.length / goldDocumentIds.length +
                englishRetrievedGold.length / goldDocumentIds.length) /
              2,
            byCase: {
              "cross-language-withdrawal":
                retrievedGold.length / goldDocumentIds.length,
              "english-withdrawal-paraphrase":
                englishRetrievedGold.length / goldDocumentIds.length,
            },
            correctSourceRank: Number.isFinite(correctSourceRank)
              ? correctSourceRank
              : null,
          },
          supportFilter: {
            correctSourcesAcceptedRate:
              correctRetrievedSourceIds.length === 0
                ? 0
                : correctAcceptedSourceIds.length /
                  correctRetrievedSourceIds.length,
            falseAbstentionRate:
              answerableCases.filter((entry) => !entry.assessment.supported)
                .length / answerableCases.length,
            falseAcceptanceRate:
              negativeCases.filter((entry) => entry.assessment.supported)
                .length / negativeCases.length,
          },
          latencyMs: Object.fromEntries(
            cases.map((entry) => [
              entry.id,
              {
                retrieval: entry.retrievalLatencyMs,
                supportVerification: entry.verificationLatencyMs,
                total: entry.retrievalLatencyMs + entry.verificationLatencyMs,
              },
            ]),
          ),
          beforeAfterMatrix: cases.map((entry) => ({
            id: entry.id,
            expected: entry.expectedSupport ? "SUPPORTED" : "ABSTAIN",
            legacyVectorMargin: legacyPureVectorSupport(entry.assessment)
              ? "SUPPORTED"
              : "ABSTAIN",
            deterministicPassageSupport: entry.assessment.supported
              ? "SUPPORTED"
              : "ABSTAIN",
            reason: entry.assessment.reason,
          })),
          literalFailures,
          passageDiagnostics: cases.map((entry) => ({
            id: entry.id,
            candidates: entry.assessment.candidateSignals.map((signal) => ({
              rank: signal.candidateRank,
              channels: signal.contributions.map(
                (contribution) => contribution.channel,
              ),
              vectorScore:
                signal.contributions.find(
                  (contribution) => contribution.channel === "vector",
                )?.rawScore ?? null,
              supportReason: signal.passageSupport.reason,
              passageSource: signal.passageSupport.passageSource,
              salientCoverage: signal.textualSupport.salientCoverage,
              answerCueCoverage: signal.passageSupport.answerCueCoverage,
              passageCharacters: signal.passageSupport.passageCharacters,
            })),
          })),
        };
        const metricsPath = path.resolve(
          process.cwd(),
          "../../reports/ci/semantic-answerability-metrics.json",
        );
        await mkdir(path.dirname(metricsPath), { recursive: true });
        await writeFile(
          metricsPath,
          `${JSON.stringify(semanticMetrics, null, 2)}\n`,
          "utf8",
        );

        console.info(
          JSON.stringify({
            semanticAnswerabilityProbe: {
              metrics: semanticMetrics,
              model: {
                provider: targetGeneration.provider,
                model: targetGeneration.model,
                revision: targetGeneration.modelRevision,
              },
            },
          }),
        );
        expect(retrievedGold).toHaveLength(goldDocumentIds.length);
        expect(englishRetrievedGold).toHaveLength(goldDocumentIds.length);
        expect(correctSourceRank).toBe(1);
        expect(limitedAssessment.supported).toBe(true);
        expect(targetAssessment.supported).toBe(true);
        expect(englishCase.assessment.supported).toBe(true);
        expect(unsupportedAssessment).toMatchObject({
          supported: false,
          reason: "SUPPORT_NOT_DEMONSTRATED",
        });
        expect(semanticNeighborCase.assessment).toMatchObject({
          supported: false,
          reason: "SUPPORT_NOT_DEMONSTRATED",
        });
        expect(semanticMetrics.supportFilter).toEqual({
          correctSourcesAcceptedRate: 1,
          falseAbstentionRate: 0,
          falseAcceptanceRate: 0,
        });
        expect(semanticMetrics.literalFailures).toEqual([]);

        resolverCalls.length = 0;
        const foreignHits = await queryKnowledge(
          db,
          {
            query,
            spaceId: fixture.spaceId,
            vaultId: foreignVaultId,
            vaultIds: [],
            federated: false,
            types: [],
            minimumTrust: "MACHINE_SUPPORTED",
            mode: "SOURCE_BACKED",
            limit: 2,
          },
          {
            vaultIds: [foreignVaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
          },
        );
        expect(foreignHits).toHaveLength(1);
        expect(foreignHits[0]?.documentId).toBe(foreignCandidate.id);
        expect(foreignHits[0]?.vaultId).toBe(foreignVaultId);
        expect(resolverCalls[0]?.generationId).toBe(
          foreignGeneration.generationId,
        );

        resolverCalls.length = 0;
        const federatedHits = await queryKnowledge(
          db,
          {
            query,
            spaceId: fixture.spaceId,
            vaultIds: [targetVaultId, foreignVaultId],
            federated: true,
            types: [],
            minimumTrust: "MACHINE_SUPPORTED",
            mode: "SOURCE_BACKED",
            limit: targetDocuments.length + 1,
          },
          {
            vaultIds: [targetVaultId, foreignVaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
          },
        );
        expect(federatedHits).toHaveLength(targetDocuments.length + 1);
        expect(federatedHits.map((hit) => hit.documentId)).toContain(
          targetRelevant.id,
        );
        expect(federatedHits.map((hit) => hit.documentId)).toContain(
          foreignCandidate.id,
        );
        expect(new Set(federatedHits.map((hit) => hit.vaultId))).toEqual(
          new Set([targetVaultId, foreignVaultId]),
        );
        expect(resolverCalls.map((call) => call.generationId).sort()).toEqual(
          [
            targetGeneration.generationId,
            foreignGeneration.generationId,
          ].sort(),
        );

        console.info(
          JSON.stringify({
            model: targetGeneration.model,
            revision: targetGeneration.modelRevision,
            dimensions: targetGeneration.dimensions,
            targetGenerationId: targetGeneration.generationId,
            targetTopDocument: targetHits[0]?.documentId,
            targetScores: targetHits.map((hit) => hit.score),
            targetVectorScores: targetHits.map((hit) => ({
              documentId: hit.documentId,
              externalId: hit.document.externalId,
              rawScore:
                hit.fusionContributions?.find(
                  (contribution) => contribution.channel === "vector",
                )?.rawScore ?? null,
            })),
            answerability: assessRetrievalAnswerability(targetHits, query),
            noAnswerProbe: {
              vectorScores: unsupportedHits.map((hit) => ({
                documentId: hit.documentId,
                rawScore:
                  hit.fusionContributions?.find(
                    (contribution) => contribution.channel === "vector",
                  )?.rawScore ?? null,
              })),
              assessment: unsupportedAssessment,
            },
            foreignGenerationId: foreignGeneration.generationId,
            foreignDocumentId: foreignCandidate.id,
          }),
        );
      } finally {
        await cleanupFixture(db, fixture);
        await adapter.dispose();
        await db.close();
        if (previousVectorEnabled === undefined) {
          delete process.env.AKP_VECTOR_ENABLED;
        } else {
          process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
        }
      }
    },
    15 * 60 * 1000,
  );
});
