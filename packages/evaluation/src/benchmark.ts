import type { GoldCase } from "./dataset.js";

/**
 * The benchmark matrix is deliberately explicit.  It is a quality experiment,
 * not the runtime query planner, so a configuration must opt in to every
 * channel it is intended to measure.
 */
export type BenchmarkChannel =
  "context-pack" | "exact" | "lexical" | "vector" | "graph";

export interface BenchmarkConfiguration {
  name: string;
  channels: readonly BenchmarkChannel[];
  allowVectorForBenchmark?: boolean;
  deterministicRerank?: boolean;
  /** Execute the authorized ASSOCIATIVE graph strategy with GRAPH_PPR. */
  associativePpr?: boolean;
  /** Execute GLOBAL routing over the versioned Leiden community index. */
  communityGlobal?: boolean;
  /** Execute seed-oriented DRIFT routing over the versioned community index. */
  communityDrift?: boolean;
  /** Optional deterministic query-decomposition evaluation. */
  queryDecomposition?: boolean;
}

/**
 * Canonical retrieval configurations. Keep this list as data so API, CLI and
 * offline evaluators cannot silently drift apart. Runtime-capability variants
 * such as PPR must be explicitly flagged rather than inferred from their name.
 */
export const V03_RETRIEVAL_BASELINE = Object.freeze({
  tag: "v0.3.0",
  commitSha: "a6bdcc38fdf026d6c353db096799366865011022",
  benchmarkMatrixBlobSha: "dca597bc97f4d3646e8d84960755ef76b5f50650",
  configurationNames: Object.freeze([
    "context-pack-only",
    "exact+lexical",
    "vector-only",
    "graph-only",
    "lexical+vector",
    "lexical+graph",
    "vector+graph",
    "context-pack+lexical+graph",
    "full-hybrid-rrf",
    "full-hybrid+rerank",
  ]),
  execution:
    "REFERENCE_PIN_ONLY: current-process results must not be relabelled as historical v0.3 execution.",
});

const RETRIEVAL_BENCHMARK_MATRIX_SOURCE: readonly BenchmarkConfiguration[] = [
  { name: "context-pack-only", channels: ["context-pack"] },
  { name: "exact+lexical", channels: ["exact", "lexical"] },
  {
    name: "vector-only",
    channels: ["vector"],
    allowVectorForBenchmark: true,
  },
  { name: "graph-only", channels: ["graph"] },
  {
    name: "lexical+vector",
    channels: ["lexical", "vector"],
    allowVectorForBenchmark: true,
  },
  { name: "lexical+graph", channels: ["lexical", "graph"] },
  {
    name: "vector+graph",
    channels: ["vector", "graph"],
    allowVectorForBenchmark: true,
  },
  {
    name: "context-pack+lexical+graph",
    channels: ["context-pack", "lexical", "graph"],
  },
  {
    name: "full-hybrid-rrf",
    channels: ["context-pack", "exact", "lexical", "vector", "graph"],
    allowVectorForBenchmark: true,
  },
  {
    name: "full-hybrid+rerank",
    channels: ["context-pack", "exact", "lexical", "vector", "graph"],
    allowVectorForBenchmark: true,
    deterministicRerank: true,
  },
  {
    name: "lexical+vector+graph",
    channels: ["lexical", "vector", "graph"],
    allowVectorForBenchmark: true,
  },
  {
    name: "lexical+vector+graph+ppr",
    channels: ["lexical", "vector", "graph"],
    allowVectorForBenchmark: true,
    associativePpr: true,
  },
  {
    name: "lexical+vector+graph+community-drift",
    channels: ["lexical", "vector", "graph"],
    allowVectorForBenchmark: true,
    communityDrift: true,
  },
  {
    name: "lexical+vector+graph+community-global",
    channels: ["lexical", "vector", "graph"],
    allowVectorForBenchmark: true,
    communityGlobal: true,
  },
  {
    name: "lexical+vector+query-decomposition",
    channels: ["lexical", "vector"],
    allowVectorForBenchmark: true,
    queryDecomposition: true,
  },
];

export const RETRIEVAL_BENCHMARK_MATRIX: readonly BenchmarkConfiguration[] =
  Object.freeze(
    RETRIEVAL_BENCHMARK_MATRIX_SOURCE.map((configuration) =>
      Object.freeze({
        ...configuration,
        channels: Object.freeze([...configuration.channels]),
      }),
    ),
  );

export interface BenchmarkObservation {
  configurationName: string;
  caseId: string;
  slice: string;
  rankedDocumentIds: string[];
  goldDocumentIds: string[];
  mustNotInclude?: string[];
  expectNoAnswer?: boolean;
  returnedAnswer?: boolean;
  /** Explicit evidence IDs, when a dataset has evidence-level labels. */
  goldEvidenceIds?: string[];
  retrievedEvidenceIds?: string[];
  /** Explicit citation IDs, when a dataset has citation-level labels. */
  goldCitationIds?: string[];
  retrievedCitationIds?: string[];
  /** Documents actually assembled into model context. */
  contextDocumentIds?: string[];
  /** Gold and retrieved support units/claims for claim-support recall. */
  goldSupportIds?: string[];
  retrievedSupportIds?: string[];
  /** Context items demonstrably used by the answer/agent. */
  usedContextIds?: string[];
  /** Explicit paired-noise judgement. True means the added noise caused failure. */
  noiseSensitiveFailure?: boolean;
  /** Explicit grounded-answer faithfulness score in [0,1]. */
  faithfulnessScore?: number;
  /** The adapter may provide a stronger unsupported-claim judgement. */
  unsupportedClaim?: boolean;
  latencyMs?: number;
  estimatedTokens?: number;
  critical?: boolean;
}

export interface BenchmarkCaseMetrics {
  recallAt5: number;
  recallAt10: number;
  /** Claim-support recall is equal to recallAt10 for this top-10 benchmark. */
  retrievalRecall: number;
  precisionAt10: number;
  reciprocalRank: number;
  ndcgAt10: number;
  evidenceRecall: number;
  contextPrecision: number;
  claimSupportRecall: number;
  citationPrecision: number;
  contextUtilization: number;
  noiseSensitivity: number;
  faithfulness: number;
  noAnswerCorrect: boolean;
  unsupportedClaim: boolean;
  estimatedTokens: number;
  latencyMs: number;
  forbidden: string[];
  /** False means the adapter/dataset did not provide evidence for this metric. */
  evidenceScored: boolean;
  contextPrecisionScored: boolean;
  claimSupportScored: boolean;
  citationScored: boolean;
  contextUtilizationScored: boolean;
  noiseSensitivityScored: boolean;
  faithfulnessScored: boolean;
}

export interface BenchmarkRunMetrics {
  configurationName: string;
  cases: number;
  passed: number;
  criticalFailures: number;
  meanRecallAt5: number;
  meanRecallAt10: number;
  meanRetrievalRecall: number;
  meanReciprocalRank: number;
  meanNdcgAt10: number;
  meanEvidenceRecall: number;
  evidenceRecallCoverage: number;
  meanContextPrecision: number;
  contextPrecisionCoverage: number;
  meanClaimSupportRecall: number;
  claimSupportRecallCoverage: number;
  meanCitationPrecision: number;
  citationPrecisionCoverage: number;
  meanContextUtilization: number;
  contextUtilizationCoverage: number;
  meanNoiseSensitivity: number;
  noiseSensitivityCoverage: number;
  meanFaithfulness: number;
  faithfulnessCoverage: number;
  unsupportedClaimRate: number;
  noAnswerAccuracy: number;
  noAnswerCases: number;
  meanEstimatedTokens: number;
  meanLatencyMs: number;
  exactIdentifierRecall: number;
  crossLanguageRecall: number;
  codeSymbolRecall: number;
  codeSymbolCases: number;
  vectorEnabled: boolean;
  rerankEnabled: boolean;
  results: Array<
    BenchmarkObservation & { metrics: BenchmarkCaseMetrics; passed: boolean }
  >;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function intersectionSize(
  left: readonly string[],
  right: readonly string[],
): number {
  const rightSet = new Set(right);
  return new Set(left).size === 0
    ? 0
    : new Set(left.filter((value) => rightSet.has(value))).size;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safeDuration(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Scores one observation.  Evidence and citation metrics remain explicitly
 * marked as unscored when the gold set has no corresponding labels; callers
 * must not present an unlabeled proxy as measured evidence quality.
 */
export function scoreBenchmarkObservation(
  observation: BenchmarkObservation,
  options: { rankedAt5?: string[]; rankedAt10?: string[] } = {},
): BenchmarkCaseMetrics {
  const ranked = unique(observation.rankedDocumentIds);
  const rankedAt5 = unique(options.rankedAt5 ?? ranked.slice(0, 5)).slice(0, 5);
  const rankedAt10 = unique(options.rankedAt10 ?? ranked.slice(0, 10)).slice(
    0,
    10,
  );
  const gold = new Set(observation.goldDocumentIds);
  const relevantAt10 = rankedAt10.filter((id) => gold.has(id));
  const first = ranked.findIndex((id) => gold.has(id));
  const dcg = rankedAt10.reduce(
    (sum, id, index) => sum + (gold.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealHits = Math.min(gold.size, 10);
  const idealDcg = Array.from({ length: idealHits }).reduce<number>(
    (sum, _value, index) => sum + 1 / Math.log2(index + 2),
    0,
  );
  const expectedNoAnswer = Boolean(observation.expectNoAnswer);
  const returnedAnswer =
    observation.returnedAnswer ?? observation.rankedDocumentIds.length > 0;
  const noAnswerCorrect = expectedNoAnswer ? !returnedAnswer : returnedAnswer;
  const forbidden = (observation.mustNotInclude ?? []).filter((id) =>
    observation.rankedDocumentIds.includes(id),
  );

  const evidenceScored = observation.goldEvidenceIds !== undefined;
  const retrievedEvidence = unique(observation.retrievedEvidenceIds ?? []);
  const evidenceRecall = evidenceScored
    ? observation.goldEvidenceIds!.length === 0
      ? 1
      : intersectionSize(retrievedEvidence, observation.goldEvidenceIds!) /
        observation.goldEvidenceIds!.length
    : 0;
  const citationScored = observation.goldCitationIds !== undefined;
  const retrievedCitations = unique(observation.retrievedCitationIds ?? []);
  const citationPrecision = citationScored
    ? retrievedCitations.length === 0
      ? observation.goldCitationIds!.length === 0
        ? 1
        : 0
      : intersectionSize(retrievedCitations, observation.goldCitationIds!) /
        retrievedCitations.length
    : 0;

  const contextPrecisionScored = observation.contextDocumentIds !== undefined;
  const contextDocuments = unique(observation.contextDocumentIds ?? []);
  const contextPrecision = contextPrecisionScored
    ? contextDocuments.length === 0
      ? observation.goldDocumentIds.length === 0
        ? 1
        : 0
      : intersectionSize(contextDocuments, observation.goldDocumentIds) /
        contextDocuments.length
    : 0;

  const claimSupportScored = observation.goldSupportIds !== undefined;
  const retrievedSupport = unique(observation.retrievedSupportIds ?? []);
  const claimSupportRecall = claimSupportScored
    ? observation.goldSupportIds!.length === 0
      ? 1
      : intersectionSize(retrievedSupport, observation.goldSupportIds!) /
        observation.goldSupportIds!.length
    : 0;

  const contextUtilizationScored =
    observation.contextDocumentIds !== undefined &&
    observation.usedContextIds !== undefined;
  const usedContext = unique(observation.usedContextIds ?? []);
  const contextUtilization = contextUtilizationScored
    ? contextDocuments.length === 0
      ? usedContext.length === 0
        ? 1
        : 0
      : intersectionSize(usedContext, contextDocuments) /
        contextDocuments.length
    : 0;

  const noiseSensitivityScored =
    observation.noiseSensitiveFailure !== undefined;
  const noiseSensitivity = noiseSensitivityScored
    ? observation.noiseSensitiveFailure
      ? 1
      : 0
    : 0;

  const faithfulnessScored =
    typeof observation.faithfulnessScore === "number" &&
    Number.isFinite(observation.faithfulnessScore) &&
    observation.faithfulnessScore >= 0 &&
    observation.faithfulnessScore <= 1;
  const faithfulness = faithfulnessScored ? observation.faithfulnessScore! : 0;

  const unsupportedClaim =
    observation.unsupportedClaim ??
    (observation.retrievedEvidenceIds !== undefined &&
      !expectedNoAnswer &&
      returnedAnswer &&
      retrievedEvidence.length === 0);

  return {
    recallAt5:
      gold.size === 0
        ? expectedNoAnswer
          ? 1
          : 0
        : intersectionSize(rankedAt5, observation.goldDocumentIds) / gold.size,
    recallAt10:
      gold.size === 0
        ? expectedNoAnswer
          ? 1
          : 0
        : relevantAt10.length / gold.size,
    retrievalRecall:
      gold.size === 0
        ? expectedNoAnswer
          ? 1
          : 0
        : relevantAt10.length / gold.size,
    precisionAt10:
      rankedAt10.length === 0 ? 0 : relevantAt10.length / rankedAt10.length,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    ndcgAt10: idealDcg === 0 ? (expectedNoAnswer ? 1 : 0) : dcg / idealDcg,
    evidenceRecall,
    contextPrecision,
    claimSupportRecall,
    citationPrecision,
    contextUtilization,
    noiseSensitivity,
    faithfulness,
    noAnswerCorrect,
    unsupportedClaim,
    estimatedTokens: Math.max(0, observation.estimatedTokens ?? 0),
    latencyMs: safeDuration(observation.latencyMs),
    forbidden,
    evidenceScored,
    contextPrecisionScored,
    claimSupportScored,
    citationScored,
    contextUtilizationScored,
    noiseSensitivityScored,
    faithfulnessScored,
  };
}

function metricResults(
  observations: readonly BenchmarkObservation[],
): Array<
  BenchmarkObservation & { metrics: BenchmarkCaseMetrics; passed: boolean }
> {
  return observations.map((observation) => {
    const metrics = scoreBenchmarkObservation(observation);
    const passed =
      (observation.expectNoAnswer
        ? metrics.noAnswerCorrect
        : metrics.recallAt10 > 0) &&
      !metrics.unsupportedClaim &&
      metrics.forbidden.length === 0;
    return { ...observation, metrics, passed };
  });
}

export function aggregateBenchmarkRun(
  configuration: BenchmarkConfiguration,
  observations: readonly BenchmarkObservation[],
): BenchmarkRunMetrics {
  const results = metricResults(observations);
  const scoredEvidence = results.filter(
    (result) => result.metrics.evidenceScored,
  );
  const scoredCitations = results.filter(
    (result) => result.metrics.citationScored,
  );
  const scoredContextPrecision = results.filter(
    (result) => result.metrics.contextPrecisionScored,
  );
  const scoredClaimSupport = results.filter(
    (result) => result.metrics.claimSupportScored,
  );
  const scoredContextUtilization = results.filter(
    (result) => result.metrics.contextUtilizationScored,
  );
  const scoredNoiseSensitivity = results.filter(
    (result) => result.metrics.noiseSensitivityScored,
  );
  const scoredFaithfulness = results.filter(
    (result) => result.metrics.faithfulnessScored,
  );
  const noAnswer = results.filter((result) => result.expectNoAnswer);
  const sliceAverage = (slice: string): number =>
    average(
      results
        .filter((result) => result.slice === slice)
        .map((result) => result.metrics.recallAt10),
    );
  return {
    configurationName: configuration.name,
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    criticalFailures: results.filter(
      (result) => Boolean(result.critical) && !result.passed,
    ).length,
    meanRecallAt5: average(results.map((result) => result.metrics.recallAt5)),
    meanRecallAt10: average(results.map((result) => result.metrics.recallAt10)),
    meanRetrievalRecall: average(
      results.map((result) => result.metrics.retrievalRecall),
    ),
    meanReciprocalRank: average(
      results.map((result) => result.metrics.reciprocalRank),
    ),
    meanNdcgAt10: average(results.map((result) => result.metrics.ndcgAt10)),
    meanEvidenceRecall: average(
      scoredEvidence.map((result) => result.metrics.evidenceRecall),
    ),
    evidenceRecallCoverage:
      results.length === 0 ? 0 : scoredEvidence.length / results.length,
    meanContextPrecision: average(
      scoredContextPrecision.map((result) => result.metrics.contextPrecision),
    ),
    contextPrecisionCoverage:
      results.length === 0 ? 0 : scoredContextPrecision.length / results.length,
    meanClaimSupportRecall: average(
      scoredClaimSupport.map((result) => result.metrics.claimSupportRecall),
    ),
    claimSupportRecallCoverage:
      results.length === 0 ? 0 : scoredClaimSupport.length / results.length,
    meanCitationPrecision: average(
      scoredCitations.map((result) => result.metrics.citationPrecision),
    ),
    citationPrecisionCoverage:
      results.length === 0 ? 0 : scoredCitations.length / results.length,
    meanContextUtilization: average(
      scoredContextUtilization.map(
        (result) => result.metrics.contextUtilization,
      ),
    ),
    contextUtilizationCoverage:
      results.length === 0
        ? 0
        : scoredContextUtilization.length / results.length,
    meanNoiseSensitivity: average(
      scoredNoiseSensitivity.map((result) => result.metrics.noiseSensitivity),
    ),
    noiseSensitivityCoverage:
      results.length === 0 ? 0 : scoredNoiseSensitivity.length / results.length,
    meanFaithfulness: average(
      scoredFaithfulness.map((result) => result.metrics.faithfulness),
    ),
    faithfulnessCoverage:
      results.length === 0 ? 0 : scoredFaithfulness.length / results.length,
    unsupportedClaimRate:
      results.length === 0
        ? 0
        : results.filter((result) => result.metrics.unsupportedClaim).length /
          results.length,
    noAnswerAccuracy:
      noAnswer.length === 0
        ? 1
        : noAnswer.filter((result) => result.metrics.noAnswerCorrect).length /
          noAnswer.length,
    noAnswerCases: noAnswer.length,
    meanEstimatedTokens: average(
      results.map((result) => result.metrics.estimatedTokens),
    ),
    meanLatencyMs: average(results.map((result) => result.metrics.latencyMs)),
    exactIdentifierRecall: sliceAverage("exact-identifiers"),
    crossLanguageRecall: sliceAverage("cross-language"),
    codeSymbolRecall: sliceAverage("code-symbol"),
    codeSymbolCases: results.filter((result) => result.slice === "code-symbol")
      .length,
    vectorEnabled: configuration.channels.includes("vector"),
    rerankEnabled: Boolean(configuration.deterministicRerank),
    results,
  };
}

export interface BenchmarkPromotionEvidence {
  /** Same dataset/slices and comparable execution path were used. */
  comparableEvaluation: boolean;
  /** Measured latency, storage/RAM, token/provider and build/update costs fit policy. */
  operationalCostAcceptable: boolean;
  /** Failure, stale-index and provider-unavailable behavior was exercised/understood. */
  degradedBehaviorUnderstood: boolean;
  /** Authorization scope and temporal truth/freshness invariants passed. */
  authorizationTruthPassed: boolean;
  /** A tested rollback path exists for the proposed retrieval default. */
  rollbackAvailable: boolean;
}

export interface BenchmarkDefaultDecision {
  selectedDefault: string | null;
  /** Best quality candidate before promotion gates; diagnostic only. */
  measuredCandidate: string | null;
  vectorActivatedByDefault: boolean;
  baseline: string | null;
  bestVector: string | null;
  promotionEligible: boolean;
  missingPromotionGates: string[];
  eligibility: string;
}

const PROMOTION_GATES: ReadonlyArray<keyof BenchmarkPromotionEvidence> = [
  "comparableEvaluation",
  "operationalCostAcceptable",
  "degradedBehaviorUnderstood",
  "authorizationTruthPassed",
  "rollbackAvailable",
];

/**
 * Select a production default only when both measured quality and explicit
 * operational/safety promotion evidence pass. Missing promotion evidence fails
 * closed: the function still reports the best measured candidate, but never
 * turns a diagnostic benchmark into a runtime-default change.
 */
export function selectBenchmarkDefault(
  runs: readonly BenchmarkRunMetrics[],
  promotionEvidence?: Partial<BenchmarkPromotionEvidence>,
): BenchmarkDefaultDecision {
  const eligible = runs.filter(
    (run) =>
      run.cases > 0 &&
      run.criticalFailures === 0 &&
      run.unsupportedClaimRate === 0 &&
      run.noAnswerAccuracy === 1,
  );
  const compare = (left: BenchmarkRunMetrics, right: BenchmarkRunMetrics) =>
    right.meanReciprocalRank - left.meanReciprocalRank ||
    right.meanNdcgAt10 - left.meanNdcgAt10 ||
    right.meanRecallAt10 - left.meanRecallAt10 ||
    right.meanCitationPrecision - left.meanCitationPrecision ||
    left.meanLatencyMs - right.meanLatencyMs ||
    left.configurationName.localeCompare(right.configurationName);
  const nonVector = eligible.filter((run) => !run.vectorEnabled).sort(compare);
  const vector = eligible.filter((run) => run.vectorEnabled).sort(compare);
  const baseline = nonVector[0];
  const bestVector = vector[0];
  const vectorEligible = Boolean(
    baseline &&
    bestVector &&
    bestVector.meanReciprocalRank >= baseline.meanReciprocalRank + 0.02 &&
    bestVector.meanRecallAt10 >= baseline.meanRecallAt10 &&
    bestVector.meanCitationPrecision >= baseline.meanCitationPrecision &&
    bestVector.exactIdentifierRecall >= baseline.exactIdentifierRecall &&
    bestVector.meanLatencyMs <= Math.max(baseline.meanLatencyMs * 2, 25),
  );
  // A vector-only experiment is never a safe implicit runtime candidate. If
  // there is no measured non-vector baseline, no candidate is promotable.
  const measuredWinner = vectorEligible ? bestVector : baseline;
  const missingPromotionGates = PROMOTION_GATES.filter(
    (gate) => promotionEvidence?.[gate] !== true,
  );
  const promotionEligible = Boolean(
    measuredWinner && missingPromotionGates.length === 0,
  );
  const selected = promotionEligible ? measuredWinner : undefined;
  return {
    selectedDefault: selected?.configurationName ?? null,
    measuredCandidate: measuredWinner?.configurationName ?? null,
    vectorActivatedByDefault: Boolean(selected?.vectorEnabled),
    baseline: baseline?.configurationName ?? null,
    bestVector: bestVector?.configurationName ?? null,
    promotionEligible,
    missingPromotionGates,
    eligibility:
      "measured: criticalFailures=0, unsupportedClaimRate=0, noAnswerAccuracy=1; vector additionally requires +0.02 MRR, no exact/citation/Recall@10 regression and <=2x latency. promotion: comparableEvaluation, operationalCostAcceptable, degradedBehaviorUnderstood, authorizationTruthPassed and rollbackAvailable must all be true.",
  };
}

/** Convert checked-in GoldCases into observations for deterministic harnesses. */
export function observationsFromGoldCases(
  cases: readonly GoldCase[],
  rankedByCase: ReadonlyMap<string, readonly string[]>,
): BenchmarkObservation[] {
  return cases.map((testCase) => ({
    configurationName: "offline",
    caseId: testCase.id,
    slice: testCase.slice ?? testCase.category,
    rankedDocumentIds: [...(rankedByCase.get(testCase.id) ?? [])],
    goldDocumentIds: [...testCase.gold_documents],
    ...(testCase.must_not_include
      ? { mustNotInclude: [...testCase.must_not_include] }
      : {}),
    ...(testCase.expect_no_answer !== undefined
      ? { expectNoAnswer: testCase.expect_no_answer }
      : {}),
    ...(testCase.gold_evidence
      ? { goldEvidenceIds: [...testCase.gold_evidence] }
      : {}),
    ...(testCase.gold_citations
      ? { goldCitationIds: [...testCase.gold_citations] }
      : {}),
    ...(testCase.critical === undefined ? {} : { critical: testCase.critical }),
  }));
}
