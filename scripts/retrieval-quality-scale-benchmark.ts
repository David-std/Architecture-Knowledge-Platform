/**
 * R8 fixed-gold quality-under-distractors benchmark.
 *
 * This is an isolated synthetic benchmark. It exercises the real
 * queryKnowledge path against parser-derived source units and records
 * candidate quality separately from deterministic evidence acceptance.
 */
import "dotenv/config";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import type { SearchHit } from "@akp/contracts";
import { buildEmbeddingIndex } from "../packages/indexing/src/index.js";
import {
  assertSyntheticFixtureDatabaseSafety,
  Postgres,
} from "../packages/postgres/src/index.js";
import {
  assessRetrievalAnswerability,
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  QueryEmbeddingService,
  type GoldEvidenceTarget,
  type EvidenceRetrievalStageSnapshot,
} from "../packages/retrieval/src/index.js";
import type { EvidenceFailureStage } from "../packages/retrieval/src/quality-diagnostics.js";
import { queryKnowledge } from "../apps/api/src/routes/search.js";
import {
  R8_QUALITY_SCALE_FIXTURE,
  type ScaleVaultKey,
} from "../evals/generic/retrieval-quality-scale/fixture.js";
import {
  appendGeneratedDistractors,
  cleanupScaleDatabaseFixture,
  createScaleDatabaseFixture,
  fixtureDefinitionHash,
  fixtureRowCounts,
  generatedDistractorFamilyCounts,
  indexGenerationMarkers,
  logicalKeyForHit,
  materializedFixtureState,
  measureProjectedUpdate,
  seedFixedFixture,
  storageDelta,
  storageSnapshot,
  type GeneratedDistractorFamily,
  type MaterializedFixtureState,
  type ResolvedGoldTarget,
  type ResolvedScaleCase,
  type ScaleDatabaseFixture,
  type StorageSnapshot,
} from "../evals/generic/retrieval-quality-scale/fixture-db.js";
import {
  buildRetrievalScaleStageAttribution,
  type RetrievalScaleStageAttribution,
} from "../evals/generic/retrieval-quality-scale/diagnostics.js";
import {
  average,
  classifyQualityScaleOutcome,
  percentile,
  scoreFalseAcceptance,
  scoreGoldRanking,
  validateExperimentContract,
  type ExperimentContract,
  type RankedGoldObservation,
} from "../evals/generic/retrieval-quality-scale/metrics.js";

const execFile = promisify(execFileCallback);
const QUERY_LIMIT = 20;
const REQUIRED_TARGETS = [1_000, 10_000, 20_000, 50_000, 100_000] as const;
const METRIC_K = [1, 5, 10, 20] as const;

type BenchmarkArm = "exact+lexical" | "hybrid-e5";
type Outcome = "PROMOTE" | "REJECT" | "INCONCLUSIVE";
type AvailableChannel =
  "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code";

interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
}

interface StageCoverage {
  channelCandidates: number;
  fusedCandidates: number;
  beforeRerank: number;
  afterRerank: number;
  returned: number;
}

interface IndexGenerationMarker {
  lexical: { kind: "CORPUS_REVISION"; value: string } | null;
  vector: { kind: "EMBEDDING_GENERATION"; id: string } | null;
}

interface CaseObservation extends RankedGoldObservation {
  caseId: string;
  slice: string;
  goldTargets: Array<{
    documentId: string;
    unitId: string;
    documentKey: string;
    unitKey: string;
    unitType: string;
    span: { startOffset: number; endOffset: number };
    sourceHash: string;
  }>;
  queryLatencyMs: number;
  returnedHitCount: number;
  admitted: boolean;
  answerabilityReason: string;
  stageCoverage: StageCoverage | null;
  goldStagePresence: {
    channelCandidates: boolean;
    fusedCandidates: boolean;
    beforeRerank: boolean;
    afterRerank: boolean;
    returned: boolean;
  } | null;
  failureStages: EvidenceFailureStage[];
  primaryFailureStage: EvidenceFailureStage | null;
  stageAttribution: RetrievalScaleStageAttribution;
  warnings: string[];
  availableChannels: string[];
}

interface TargetResult {
  distractorCount: number;
  distractorFamilies: Record<GeneratedDistractorFamily, number>;
  totalDocuments: number;
  totalUnits: number;
  totalEmbeddings: number;
  indexTimeMs: number;
  updateTimeMs: number | null;
  queryLatencyMs: {
    samples: number;
    p50: number | null;
    p95: number | null;
    mean: number | null;
  };
  storage: {
    after: StorageSnapshot;
    deltaFromFixtureBaseline: StorageSnapshot;
  };
  memory: {
    beforeQueries: MemorySnapshot;
    afterQueries: MemorySnapshot;
  };
  indexGeneration: Record<ScaleVaultKey, IndexGenerationMarker>;
  relevance: ReturnType<typeof scoreGoldRanking>;
  falseAcceptance: ReturnType<typeof scoreFalseAcceptance>;
  cases: CaseObservation[];
}

interface BenchmarkReport {
  schemaVersion: "akp.retrieval-quality-scale.v1";
  generatedAt: string;
  outcome: Outcome;
  promotionScope: "benchmark-evidence-only";
  evidenceLevel: "SYNTHETIC_ISOLATED_POSTGRES";
  scope: {
    runKind: "FULL" | "REDUCED_SCOPE";
    reducedScopeBoundary: string | null;
    arm: BenchmarkArm;
    queryLimit: number;
    targets: number[];
  };
  experiment: {
    contract: ExperimentContract;
    contractComplete: boolean;
    missingContractFields: string[];
    independentVariable: "distractorCount";
    baseline: string;
    candidate: string;
    configuration: Record<string, unknown>;
    configurationHash: string;
    dataset: {
      version: string;
      definitionHash: string;
      sourceHashes: Record<string, string>;
      corpusRevision: string;
      fixedDocumentCount: number;
      fixedCaseCount: number;
    };
    indexGenerations: Record<
      string,
      Record<ScaleVaultKey, IndexGenerationMarker>
    >;
  };
  acceptance: {
    fixedGold: boolean;
    goldLabelScope: "CLOSED_GOLD_BENCHMARK";
    semanticLabelAuthorityMeasured: false;
    goldResolvedBeforeRetrieval: boolean;
    queryKnowledgeUsed: boolean;
    parserUsed: string;
    syntheticFixtureDatabase: boolean;
    defaultProvidersEnabled: boolean;
    topKBoundsChanged: boolean;
    cleanupSucceeded: boolean;
    remainingRows: { documents: number; units: number; embeddings: number };
  };
  measured: string[];
  notMeasured: Array<{ dimension: string; reason: string }>;
  limitations: string[];
  results: TargetResult[];
  cleanup: {
    succeeded: boolean;
    remainingRows: { documents: number; units: number; embeddings: number };
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseTargets(
  value: string | undefined,
  reducedScope: boolean,
): number[] {
  const raw = value ?? REQUIRED_TARGETS.join(",");
  const targets = raw
    .split(",")
    .map((entry) => parsePositiveInteger(entry.trim(), "distractor count"));
  if (targets.length === 0)
    throw new Error("At least one distractor count is required");
  const unique = [...new Set(targets)];
  if (unique.length !== targets.length)
    throw new Error("distractor counts must be unique");
  for (let index = 1; index < targets.length; index += 1) {
    if (targets[index]! <= targets[index - 1]!) {
      throw new Error("distractor counts must be strictly ascending");
    }
  }
  if (targets.some((target) => target < 1_000) && !reducedScope) {
    throw new Error(
      "counts below 1000 require the explicit --reduced-scope flag",
    );
  }
  if (targets.some((target) => target > 100_000)) {
    throw new Error("this benchmark refuses distractor counts above 100000");
  }
  if (
    !reducedScope &&
    JSON.stringify(targets) !== JSON.stringify(REQUIRED_TARGETS)
  ) {
    throw new Error(
      `full R8 runs require exactly ${REQUIRED_TARGETS.join(",")}; use --reduced-scope for an explicit reduced validation matrix`,
    );
  }
  return targets;
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function logicalTargetKey(target: ResolvedGoldTarget): string {
  return target.identityKey;
}

function hitIdentityKey(
  fixture: ScaleDatabaseFixture,
  hit: Pick<SearchHit, "documentId" | "unitId">,
): string {
  return logicalKeyForHit(fixture, hit.documentId, hit.unitId);
}

function candidateKeyToLogical(
  fixture: ScaleDatabaseFixture,
  candidateKey: string,
): string {
  const separator = candidateKey.indexOf(":");
  if (separator < 0) return "UNKNOWN_CANDIDATE";
  const documentId = candidateKey.slice(0, separator);
  const unitPart = candidateKey.slice(separator + 1);
  return logicalKeyForHit(
    fixture,
    documentId,
    unitPart === "document" ? null : unitPart,
  );
}

function stageHasGold(
  fixture: ScaleDatabaseFixture,
  stage: readonly { documentId: string; unitId: string | null }[],
  gold: readonly ResolvedGoldTarget[],
): boolean {
  return gold.some((target) => {
    const documentId = fixture.documentIds.get(target.documentKey);
    const unitId = fixture.unitIds.get(target.identityKey);
    return stage.some(
      (identity) =>
        identity.documentId === documentId && identity.unitId === unitId,
    );
  });
}

function stageCoverage(
  fixture: ScaleDatabaseFixture,
  snapshot: EvidenceRetrievalStageSnapshot | undefined,
  gold: readonly ResolvedGoldTarget[],
): {
  counts: StageCoverage;
  goldPresence: CaseObservation["goldStagePresence"];
} | null {
  if (!snapshot) return null;
  const stages = {
    channelCandidates: snapshot.channelCandidates,
    fusedCandidates: snapshot.fusedCandidates,
    beforeRerank: snapshot.beforeRerank,
    afterRerank: snapshot.afterRerank,
    returned: snapshot.returned,
  };
  return {
    counts: {
      channelCandidates: stages.channelCandidates.length,
      fusedCandidates: stages.fusedCandidates.length,
      beforeRerank: stages.beforeRerank.length,
      afterRerank: stages.afterRerank.length,
      returned: stages.returned.length,
    },
    goldPresence: {
      channelCandidates: stageHasGold(fixture, stages.channelCandidates, gold),
      fusedCandidates: stageHasGold(fixture, stages.fusedCandidates, gold),
      beforeRerank: stageHasGold(fixture, stages.beforeRerank, gold),
      afterRerank: stageHasGold(fixture, stages.afterRerank, gold),
      returned: stageHasGold(fixture, stages.returned, gold),
    },
  };
}

function goldEvidenceTargets(
  fixture: ScaleDatabaseFixture,
  testCase: ResolvedScaleCase,
): GoldEvidenceTarget[] {
  return testCase.gold.map((target) => {
    const documentId = fixture.documentIds.get(target.documentKey);
    const unitId = fixture.unitIds.get(target.identityKey);
    if (!documentId || !unitId) {
      throw new Error(`Missing fixed gold identity for ${target.identityKey}`);
    }
    return {
      documentId,
      unitId,
      evidenceSpan: target.span,
    };
  });
}

function indexGenerationContractValue(
  corpusRevision: string,
  arm: BenchmarkArm,
  generations: BenchmarkReport["experiment"]["indexGenerations"],
): string {
  const lastTarget = Object.keys(generations).at(-1) ?? "0";
  return JSON.stringify({
    lexical: {
      kind: "CORPUS_REVISION",
      value: corpusRevision,
    },
    arm,
    latestPerVault: generations[lastTarget] ?? null,
  });
}

async function gitHead(): Promise<string> {
  const result = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
  });
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(value))
    throw new Error("Unable to resolve Git HEAD");
  return value;
}

function sourceHashes(): Record<string, string> {
  return Object.fromEntries(
    R8_QUALITY_SCALE_FIXTURE.documents.map((document) => [
      document.key,
      sha256(document.body),
    ]),
  );
}

async function buildDenseIndexes(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
  adapter: LocalSemanticEmbeddingAdapter,
): Promise<{ elapsedMs: number; generations: Record<ScaleVaultKey, string> }> {
  const started = performance.now();
  const generations = {} as Record<ScaleVaultKey, string>;
  for (const vaultKey of ["gold", "other-vault"] as const) {
    const vaultId = fixture.vaultIds.get(vaultKey);
    if (!vaultId) throw new Error(`Missing ${vaultKey} vault`);
    const result = await buildEmbeddingIndex(db, {
      spaceId: fixture.spaceId,
      vaultId,
      corpusRevision: fixture.corpusRevision,
      provider: adapter,
      activate: true,
      batchSize: 8,
    });
    if (!result.activated || result.generation.status !== "ACTIVE") {
      throw new Error(`Dense generation did not activate for ${vaultKey}`);
    }
    generations[vaultKey] = result.generation.generationId;
  }
  return { elapsedMs: performance.now() - started, generations };
}

async function executeCase(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
  testCase: ResolvedScaleCase,
  arm: BenchmarkArm,
  queryEmbeddingService: QueryEmbeddingService | undefined,
  materialized: MaterializedFixtureState,
): Promise<CaseObservation> {
  const vaultIds = testCase.definition.vaults.map((vault) => {
    const value = fixture.vaultIds.get(vault);
    if (!value) throw new Error(`Missing vault ${vault}`);
    return value;
  });
  const input = {
    query: testCase.definition.query,
    spaceId: fixture.spaceId,
    vaultIds,
    federated: vaultIds.length > 1,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED" as const,
    mode: "SOURCE_BACKED" as const,
    limit: QUERY_LIMIT,
    ...(vaultIds.length === 1 ? { vaultId: vaultIds[0] } : {}),
  };
  const warnings: string[] = [];
  const availableChannels = new Set<AvailableChannel>();
  let candidates: readonly SearchHit[] | undefined;
  let diagnostics: EvidenceRetrievalStageSnapshot | undefined;
  const started = performance.now();
  const hits = await queryKnowledge(db, input, {
    vaultIds,
    channels:
      arm === "hybrid-e5"
        ? ["exact", "lexical", "vector"]
        : ["exact", "lexical"],
    ...(arm === "hybrid-e5"
      ? {
          allowVectorForBenchmark: true,
          queryEmbeddingService: queryEmbeddingService!,
        }
      : {}),
    warningSink: warnings,
    availableChannelSink: availableChannels,
    answerabilityCandidateSink: (value) => {
      candidates = value;
    },
    stageDiagnosticSink: (value) => {
      diagnostics = value;
    },
  });
  const queryLatencyMs = performance.now() - started;
  const assessment = assessRetrievalAnswerability(
    hits,
    testCase.definition.query,
    {},
    candidates ? { comparisonHits: candidates } : {},
  );
  const rankedUnitKeys = hits.map((hit) => hitIdentityKey(fixture, hit));
  const admittedUnitKeys = assessment.supportedCandidateKeys.map((key) =>
    candidateKeyToLogical(fixture, key),
  );
  const expected = goldEvidenceTargets(fixture, testCase);
  const staged = stageCoverage(fixture, diagnostics, testCase.gold);
  const attribution = buildRetrievalScaleStageAttribution({
    caseId: testCase.definition.id,
    expected,
    admissible: expected.map(({ documentId, unitId }) => ({
      documentId,
      unitId,
    })),
    labelsComplete: false,
    labelScope: "CLOSED_GOLD_BENCHMARK",
    sourceDocuments: materialized.sourceDocuments,
    materializedUnits: materialized.units,
    snapshot: diagnostics,
    returnedHits: hits,
    assessment,
    shortlistLimit: QUERY_LIMIT,
  });
  const failureStages = [
    ...new Set(attribution.failures.map((failure) => failure.stage)),
  ];
  return {
    caseId: testCase.definition.id,
    slice: testCase.definition.slice,
    goldTargets: testCase.gold.map((target, index) => ({
      documentId: expected[index]!.documentId,
      unitId: expected[index]!.unitId!,
      documentKey: target.documentKey,
      unitKey: target.unitKey,
      unitType: target.unitType,
      span: target.span,
      sourceHash: target.sourceHash,
    })),
    rankedUnitKeys,
    goldUnitKeys: testCase.gold.map(logicalTargetKey),
    ...(testCase.definition.expectNoAnswer === true
      ? { expectNoAnswer: true }
      : {}),
    admittedUnitKeys,
    queryLatencyMs,
    returnedHitCount: hits.length,
    admitted: assessment.supported,
    answerabilityReason: assessment.reason,
    stageCoverage: staged?.counts ?? null,
    goldStagePresence: staged?.goldPresence ?? null,
    failureStages,
    primaryFailureStage: failureStages[0] ?? null,
    stageAttribution: attribution,
    warnings,
    availableChannels: [...availableChannels].sort(),
  };
}

function experimentContract(
  baselineSha: string,
  candidateSha: string,
  fixture: ScaleDatabaseFixture,
  arm: BenchmarkArm,
  configurationHash: string,
  indexGeneration: string,
): ExperimentContract {
  return {
    hypothesis:
      "A fixed gold set retains candidate-unit quality as unrelated and adversarial distractors grow.",
    failureStage: "CANDIDATE_NOT_RETRIEVED",
    baselineSha,
    candidateSha,
    datasetVersion: R8_QUALITY_SCALE_FIXTURE.version,
    datasetHash: fixtureDefinitionHash(R8_QUALITY_SCALE_FIXTURE),
    indexGeneration,
    embeddingModelRevision:
      arm === "hybrid-e5"
        ? LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.modelRevision
        : "disabled",
    rerankerRevision: "disabled",
    readerRevision: "deterministic-answerability-v1",
    configurationHash,
    singleIndependentVariable: "distractorCount",
    primaryMetric: "goldUnitFractionRecallAt10",
    guardrailMetrics: [
      "goldUnitRecallAt1",
      "goldUnitRecallAt5",
      "goldUnitRecallAt20",
      "goldUnitAnyHitAt10",
      "mrr",
      "ndcg",
      "falseAcceptance",
      "ADMISSION_FALSE_POSITIVE",
      "negativeFalseAcceptance",
      "p50QueryLatencyMs",
      "p95QueryLatencyMs",
      "indexTimeMs",
      "updateTimeMs",
      "storageDeltaBytes",
    ],
    expectedFailureIfWrong:
      "Gold unit recall, MRR or nDCG declines materially, or false acceptance rises as distractorCount increases.",
    promotionRule:
      "PROMOTE benchmark evidence only when the full target matrix reaches 100000, baseline and final false acceptance are at most 0.20, and no declared quality guardrail regresses beyond the configured tolerance; otherwise REJECT on a measured regression or INCONCLUSIVE when scope is incomplete.",
    rollback:
      "Discard this benchmark arm/report; no runtime provider, reranker or default configuration is changed.",
  };
}

function usage(): void {
  process.stdout.write(
    `Usage: tsx scripts/retrieval-quality-scale-benchmark.ts [options]\n\nOptions:\n  --distractor-counts <list>  Ascending counts (default: 1000,10000,20000,50000,100000)\n  --iterations <n>             Query repetitions per case and target (default: 3)\n  --seed <text>                Deterministic source/content seed (default: akp-r8-quality-v1)\n  --arm <name>                 exact+lexical (default) or hybrid-e5 (optional real E5)\n  --reduced-scope              Permit counts below 1000; report remains out of full scope\n  --output <path>              JSON output (default: .work/retrieval-quality-scale/r8-benchmark.json)\n  --stdout                     Print JSON and do not write an output file\n  --help                       Show this help\n\nDATABASE_URL must point to a disposable synthetic PostgreSQL database.\nThe hybrid-e5 arm requires AKP_MODEL_CACHE_DIR and uses the pinned local E5 descriptor.\n`,
  );
}

async function runBenchmark(
  databaseUrl: string,
  targets: readonly number[],
  iterations: number,
  seed: string,
  arm: BenchmarkArm,
  reducedScope: boolean,
): Promise<BenchmarkReport> {
  assertSyntheticFixtureDatabaseSafety(databaseUrl);
  const db = new Postgres(databaseUrl);
  const fixture = createScaleDatabaseFixture(seed, R8_QUALITY_SCALE_FIXTURE);
  const originalVectorFlag = process.env.AKP_VECTOR_ENABLED;
  const dense = arm === "hybrid-e5";
  let adapter: LocalSemanticEmbeddingAdapter | undefined;
  let queryEmbeddingService: QueryEmbeddingService | undefined;
  let cleanupSucceeded = false;
  let remainingRows = { documents: 0, units: 0, embeddings: 0 };
  const results: TargetResult[] = [];
  const indexGenerations: BenchmarkReport["experiment"]["indexGenerations"] =
    {};
  try {
    if (dense) {
      process.env.AKP_VECTOR_ENABLED = "true";
      adapter = new LocalSemanticEmbeddingAdapter({
        ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
          ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
          : {}),
        localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
        maxBatchSize: 8,
      });
      queryEmbeddingService = new QueryEmbeddingService(async () => adapter!);
    }
    const seedStarted = performance.now();
    await seedFixedFixture(db, fixture, R8_QUALITY_SCALE_FIXTURE);
    const fixedIndexMs = performance.now() - seedStarted;
    const storageAfterFixed = await storageSnapshot(db);
    const fixtureBaselineStorage = storageAfterFixed;
    for (const distractorCount of [0, ...targets]) {
      let appendIndexMs = 0;
      if (distractorCount > fixture.generatedDistractors) {
        const generated = await appendGeneratedDistractors(
          db,
          fixture,
          distractorCount,
        );
        appendIndexMs = generated.indexMs;
        if (
          generated.appended !==
          distractorCount -
            (distractorCount === 0
              ? 0
              : (targets[targets.indexOf(distractorCount) - 1] ?? 0))
        ) {
          // The fixture itself enforces ascending cumulative targets. This
          // branch only protects report evidence if a caller changes that.
          throw new Error("Generated distractor append count is inconsistent");
        }
      }
      let denseIndexMs = 0;
      if (dense) {
        const denseIndex = await buildDenseIndexes(db, fixture, adapter!);
        denseIndexMs = denseIndex.elapsedMs;
      }
      const indexMs =
        distractorCount === 0
          ? fixedIndexMs + denseIndexMs
          : appendIndexMs + denseIndexMs;
      const updateTimeMs = await measureProjectedUpdate(db, fixture);
      const materialized = await materializedFixtureState(db, fixture);
      const beforeQueries = memorySnapshot();
      const querySamples: number[] = [];
      let firstIteration: CaseObservation[] = [];
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const observations: CaseObservation[] = [];
        for (const testCase of fixture.resolvedCases) {
          const observation = await executeCase(
            db,
            fixture,
            testCase,
            arm,
            queryEmbeddingService,
            materialized,
          );
          querySamples.push(observation.queryLatencyMs);
          observations.push(observation);
        }
        if (iteration === 0) firstIteration = observations;
      }
      const afterQueries = memorySnapshot();
      const rankedObservations: RankedGoldObservation[] = firstIteration.map(
        (observation) => ({
          caseId: observation.caseId,
          rankedUnitKeys: observation.rankedUnitKeys,
          goldUnitKeys: observation.goldUnitKeys,
          ...(observation.expectNoAnswer === true
            ? { expectNoAnswer: true }
            : {}),
          ...(observation.admittedUnitKeys
            ? { admittedUnitKeys: observation.admittedUnitKeys }
            : {}),
        }),
      );
      const storageAfter = await storageSnapshot(db);
      const rows = await fixtureRowCounts(db, fixture);
      const markers = await indexGenerationMarkers(db, fixture);
      indexGenerations[String(distractorCount)] = markers;
      results.push({
        distractorCount,
        distractorFamilies: generatedDistractorFamilyCounts(distractorCount),
        totalDocuments: rows.documents,
        totalUnits: rows.units,
        totalEmbeddings: rows.embeddings,
        indexTimeMs: round(indexMs) ?? 0,
        updateTimeMs: round(updateTimeMs),
        queryLatencyMs: {
          samples: querySamples.length,
          p50: round(percentile(querySamples, 0.5)),
          p95: round(percentile(querySamples, 0.95)),
          mean: round(average(querySamples)),
        },
        storage: {
          after: storageAfter,
          deltaFromFixtureBaseline: storageDelta(
            storageAfter,
            fixtureBaselineStorage,
          ),
        },
        memory: { beforeQueries, afterQueries },
        indexGeneration: markers,
        relevance: scoreGoldRanking(rankedObservations, METRIC_K),
        falseAcceptance: scoreFalseAcceptance(rankedObservations),
        cases: firstIteration,
      });
    }

    const baselineSha =
      process.env.AKP_R8_BASELINE_SHA?.trim() || (await gitHead());
    const candidateSha = await gitHead();
    const configuration = {
      arm,
      channels: dense ? ["exact", "lexical", "vector"] : ["exact", "lexical"],
      queryLimit: QUERY_LIMIT,
      reranker: "disabled",
      reader: "deterministic-answerability-v1",
      providerDefaultsEnabled: false,
      topKBoundsChanged: false,
      seed,
      targets: [...targets],
    } satisfies Record<string, unknown>;
    const configurationHash = sha256(JSON.stringify(configuration));
    const contract = experimentContract(
      baselineSha,
      candidateSha,
      fixture,
      arm,
      configurationHash,
      indexGenerationContractValue(
        fixture.corpusRevision,
        arm,
        indexGenerations,
      ),
    );
    const contractValidation = validateExperimentContract(contract);
    const baselineResult = results.find(
      (result) => result.distractorCount === 0,
    );
    const finalResult = results.find(
      (result) => result.distractorCount === 100_000,
    );
    const reportOutcome = classifyQualityScaleOutcome({
      baseline: baselineResult
        ? {
            recallAt10: baselineResult.relevance.recallAtK["10"] ?? 0,
            mrr: baselineResult.relevance.mrr,
            ndcg: baselineResult.relevance.ndcg,
            falseAcceptanceRate: baselineResult.falseAcceptance.rate,
          }
        : null,
      final: finalResult
        ? {
            recallAt10: finalResult.relevance.recallAtK["10"] ?? 0,
            mrr: finalResult.relevance.mrr,
            ndcg: finalResult.relevance.ndcg,
            falseAcceptanceRate: finalResult.falseAcceptance.rate,
          }
        : null,
      contractComplete: contractValidation.complete,
      reducedScope,
    });
    const cleanupRemaining = await cleanupScaleDatabaseFixture(db, fixture);
    remainingRows = cleanupRemaining;
    cleanupSucceeded =
      cleanupRemaining.documents === 0 &&
      cleanupRemaining.units === 0 &&
      cleanupRemaining.embeddings === 0;
    return {
      schemaVersion: "akp.retrieval-quality-scale.v1",
      generatedAt: new Date().toISOString(),
      outcome: reportOutcome,
      promotionScope: "benchmark-evidence-only",
      evidenceLevel: "SYNTHETIC_ISOLATED_POSTGRES",
      scope: {
        runKind: reducedScope ? "REDUCED_SCOPE" : "FULL",
        reducedScopeBoundary: reducedScope
          ? "Counts below 1000 are reduced-scope only and do not satisfy R8 full-scale DoD."
          : null,
        arm,
        queryLimit: QUERY_LIMIT,
        targets: [0, ...targets],
      },
      experiment: {
        contract,
        contractComplete: contractValidation.complete,
        missingContractFields: contractValidation.missingFields,
        independentVariable: "distractorCount",
        baseline: "exact+lexical",
        candidate: arm,
        configuration,
        configurationHash,
        dataset: {
          version: R8_QUALITY_SCALE_FIXTURE.version,
          definitionHash: fixtureDefinitionHash(R8_QUALITY_SCALE_FIXTURE),
          sourceHashes: sourceHashes(),
          corpusRevision: fixture.corpusRevision,
          fixedDocumentCount: fixture.fixedDocumentCount,
          fixedCaseCount: fixture.resolvedCases.length,
        },
        indexGenerations,
      },
      acceptance: {
        fixedGold: true,
        goldLabelScope: "CLOSED_GOLD_BENCHMARK",
        semanticLabelAuthorityMeasured: false,
        goldResolvedBeforeRetrieval: true,
        queryKnowledgeUsed: true,
        parserUsed: "parseKnowledgeUnits",
        syntheticFixtureDatabase: true,
        defaultProvidersEnabled: false,
        topKBoundsChanged: false,
        cleanupSucceeded,
        remainingRows,
      },
      measured: [
        "gold-unit Recall@1/5/10/20",
        "MRR",
        "nDCG",
        "admitted units outside the closed benchmark gold set, separated from ranking relevance",
        "p50/p95 query latency",
        "lexical projection/index write time",
        "projected update time",
        "PostgreSQL storage growth",
        "metadata-only stage diagnostics with R1 failure enums",
        "admitted-unit identity overlap with the closed benchmark gold set",
        "expected document/unit/source-span labels with actual candidate metadata",
        "source documents and materialized units read from the live fixture database",
        "adversarial distractor family multiplicity at every scale target",
      ],
      notMeasured: [
        {
          dimension: "context packet inclusion",
          reason:
            "The R8 harness does not build a context packet; stage attribution records context as unmeasured.",
        },
        {
          dimension: "answer generation",
          reason:
            "The R8 harness stops at retrieval and deterministic answerability.",
        },
        {
          dimension: "semantic exact-span precision",
          reason:
            "Gold source spans are annotated, but no provider/verifier quote span is supplied by this arm.",
        },
        {
          dimension:
            "semantic authority and completeness of closed gold labels",
          reason:
            "Active near-duplicate and contradictory policy sources can be valid alternatives or contradictions; outside-gold counts are not universal false-acceptance precision.",
        },
        {
          dimension: "private vault quality",
          reason: "Only generic synthetic source text is used.",
        },
        {
          dimension: "worker incremental index workflow",
          reason:
            "Update timing covers SQL projection writes and ANALYZE, not durable worker orchestration.",
        },
        {
          dimension: "reranker quality",
          reason:
            "Reranking is disabled and is a separate experiment variable.",
        },
        {
          dimension: "runtime default promotion",
          reason:
            "The report cannot enable providers or change production defaults.",
        },
        ...(dense
          ? []
          : [
              {
                dimension: "dense retrieval quality",
                reason:
                  "The optional real E5 arm was not requested for this run.",
              },
            ]),
      ],
      limitations: [
        "The fixed gold corpus is synthetic and is a regression measurement, not a general precision claim.",
        "Closed-gold outside-set admission counts are benchmark-label comparisons, not claims that every excluded source is semantically false or non-authoritative.",
        "Targets are cumulative in one disposable fixture; cache and warm index state can affect latency.",
        "Generated distractors scale deterministically across unrelated, near-duplicate, stale-version, same-title/other-vault, wrong-relation, close-number/date and contradictory-policy families.",
        "The dense arm, when selected, uses the pinned local multilingual E5 descriptor and real inference; no fake vectors are inserted.",
      ],
      results,
      cleanup: { succeeded: cleanupSucceeded, remainingRows },
    };
  } finally {
    if (!cleanupSucceeded) {
      try {
        const cleanupRemaining = await cleanupScaleDatabaseFixture(db, fixture);
        remainingRows = cleanupRemaining;
      } catch {
        // The caller receives the original benchmark error. Cleanup evidence
        // remains available in the process output when this path fails.
      }
    }
    if (originalVectorFlag === undefined) delete process.env.AKP_VECTOR_ENABLED;
    else process.env.AKP_VECTOR_ENABLED = originalVectorFlag;
    await db.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    usage();
    return;
  }
  const reducedScope = hasFlag(argv, "--reduced-scope");
  const targets = parseTargets(
    parseArg(argv, "--distractor-counts"),
    reducedScope,
  );
  const iterations = parsePositiveInteger(
    parseArg(argv, "--iterations") ?? "3",
    "iterations",
  );
  const seed = parseArg(argv, "--seed") ?? "akp-r8-quality-v1";
  const armValue = parseArg(argv, "--arm") ?? "exact+lexical";
  if (armValue !== "exact+lexical" && armValue !== "hybrid-e5") {
    throw new Error("--arm must be exact+lexical or hybrid-e5");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const report = await runBenchmark(
    databaseUrl,
    targets,
    iterations,
    seed,
    armValue,
    reducedScope,
  );
  const outputPath = path.resolve(
    parseArg(argv, "--output") ??
      ".work/retrieval-quality-scale/r8-benchmark.json",
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (hasFlag(argv, "--stdout")) process.stdout.write(serialized);
  else {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
    process.stdout.write(
      `${JSON.stringify({ outcome: report.outcome, outputPath, cleanup: report.cleanup })}\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
