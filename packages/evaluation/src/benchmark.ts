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
}

/**
 * The ten configurations required by the retrieval specification.  Keep this
 * list as data so API, CLI and offline evaluators cannot silently drift apart.
 */
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
  /** The adapter may provide a stronger unsupported-claim judgement. */
  unsupportedClaim?: boolean;
  latencyMs?: number;
  estimatedTokens?: number;
  critical?: boolean;
}

export interface BenchmarkCaseMetrics {
  recallAt5: number;
  recallAt10: number;
  precisionAt10: number;
  reciprocalRank: number;
  ndcgAt10: number;
  evidenceRecall: number;
  citationPrecision: number;
  noAnswerCorrect: boolean;
  unsupportedClaim: boolean;
  estimatedTokens: number;
  latencyMs: number;
  forbidden: string[];
  /** False means the dataset did not provide labels for this metric. */
  evidenceScored: boolean;
  citationScored: boolean;
}

export interface BenchmarkRunMetrics {
  configurationName: string;
  cases: number;
  passed: number;
  criticalFailures: number;
  meanRecallAt5: number;
  meanRecallAt10: number;
  meanReciprocalRank: number;
  meanNdcgAt10: number;
  meanEvidenceRecall: number;
  evidenceRecallCoverage: number;
  meanCitationPrecision: number;
  citationPrecisionCoverage: number;
  unsupportedClaimRate: number;
  noAnswerAccuracy: number;
  noAnswerCases: number;
  meanEstimatedTokens: number;
  meanLatencyMs: number;
  exactIdentifierRecall: number;
  crossLanguageRecall: number;
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
  const rankedAt5 =
    options.rankedAt5 ?? observation.rankedDocumentIds.slice(0, 5);
  const rankedAt10 =
    options.rankedAt10 ?? observation.rankedDocumentIds.slice(0, 10);
  const gold = new Set(observation.goldDocumentIds);
  const relevantAt10 = rankedAt10.filter((id) => gold.has(id));
  const first = observation.rankedDocumentIds.findIndex((id) => gold.has(id));
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
  const retrievedEvidence = observation.retrievedEvidenceIds ?? [];
  const evidenceRecall = evidenceScored
    ? observation.goldEvidenceIds!.length === 0
      ? 1
      : intersectionSize(retrievedEvidence, observation.goldEvidenceIds!) /
        observation.goldEvidenceIds!.length
    : 0;
  const citationScored = observation.goldCitationIds !== undefined;
  const retrievedCitations = observation.retrievedCitationIds ?? [];
  const citationPrecision = citationScored
    ? retrievedCitations.length === 0
      ? observation.goldCitationIds!.length === 0
        ? 1
        : 0
      : intersectionSize(retrievedCitations, observation.goldCitationIds!) /
        retrievedCitations.length
    : 0;
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
    precisionAt10:
      rankedAt10.length === 0 ? 0 : relevantAt10.length / rankedAt10.length,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    ndcgAt10: idealDcg === 0 ? (expectedNoAnswer ? 1 : 0) : dcg / idealDcg,
    evidenceRecall,
    citationPrecision,
    noAnswerCorrect,
    unsupportedClaim,
    estimatedTokens: Math.max(0, observation.estimatedTokens ?? 0),
    latencyMs: safeDuration(observation.latencyMs),
    forbidden,
    evidenceScored,
    citationScored,
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
    meanReciprocalRank: average(
      results.map((result) => result.metrics.reciprocalRank),
    ),
    meanNdcgAt10: average(results.map((result) => result.metrics.ndcgAt10)),
    meanEvidenceRecall: average(
      scoredEvidence.map((result) => result.metrics.evidenceRecall),
    ),
    evidenceRecallCoverage:
      results.length === 0 ? 0 : scoredEvidence.length / results.length,
    meanCitationPrecision: average(
      scoredCitations.map((result) => result.metrics.citationPrecision),
    ),
    citationPrecisionCoverage:
      results.length === 0 ? 0 : scoredCitations.length / results.length,
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
    vectorEnabled: configuration.channels.includes("vector"),
    rerankEnabled: Boolean(configuration.deterministicRerank),
    results,
  };
}

export interface BenchmarkDefaultDecision {
  selectedDefault: string | null;
  vectorActivatedByDefault: boolean;
  baseline: string | null;
  bestVector: string | null;
  eligibility: string;
}

/**
 * Selects only from measured, eligible runs.  A vector run cannot become the
 * default merely because it exists; it must improve quality without violating
 * exact-identifier, citation, no-answer or latency guardrails.
 */
export function selectBenchmarkDefault(
  runs: readonly BenchmarkRunMetrics[],
): BenchmarkDefaultDecision {
  const eligible = runs.filter(
    (run) =>
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
  const winner = vectorEligible
    ? bestVector
    : (baseline ?? eligible.sort(compare)[0]);
  return {
    selectedDefault: winner?.configurationName ?? null,
    vectorActivatedByDefault: vectorEligible,
    baseline: baseline?.configurationName ?? null,
    bestVector: bestVector?.configurationName ?? null,
    eligibility:
      "criticalFailures=0, unsupportedClaimRate=0, noAnswerAccuracy=1; vector requires +0.02 MRR, no exact/citation/Recall@10 regression and <=2x latency",
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
    ...(testCase.critical === undefined ? {} : { critical: testCase.critical }),
  }));
}
