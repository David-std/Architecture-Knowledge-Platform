import { describe, expect, it } from "vitest";
import {
  RETRIEVAL_BENCHMARK_MATRIX,
  V03_RETRIEVAL_BASELINE,
  aggregateBenchmarkRun,
  scoreBenchmarkObservation,
  selectBenchmarkDefault,
} from "../src/index.js";

describe("retrieval benchmark matrix", () => {
  it("contains the auditable retrieval configurations including real PPR", () => {
    expect(RETRIEVAL_BENCHMARK_MATRIX.map(({ name }) => name)).toEqual([
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
      "lexical+vector+graph+ppr",
      "lexical+vector+graph+community-global",
    ]);
    expect(RETRIEVAL_BENCHMARK_MATRIX).toHaveLength(12);
    expect(
      RETRIEVAL_BENCHMARK_MATRIX.filter(({ channels }) =>
        channels.includes("vector"),
      ).every(({ allowVectorForBenchmark }) => allowVectorForBenchmark),
    ).toBe(true);
    expect(
      RETRIEVAL_BENCHMARK_MATRIX.find(
        ({ name }) => name === "lexical+vector+graph+ppr",
      ),
    ).toMatchObject({
      associativePpr: true,
      channels: ["lexical", "vector", "graph"],
    });
    expect(
      RETRIEVAL_BENCHMARK_MATRIX.find(
        ({ name }) => name === "lexical+vector+graph+community-global",
      ),
    ).toMatchObject({
      communityGlobal: true,
      channels: ["lexical", "vector", "graph"],
    });
    expect(V03_RETRIEVAL_BASELINE).toMatchObject({
      tag: "v0.3.0",
      commitSha: "a6bdcc38fdf026d6c353db096799366865011022",
      benchmarkMatrixBlobSha: "dca597bc97f4d3646e8d84960755ef76b5f50650",
    });
    expect(V03_RETRIEVAL_BASELINE.configurationNames).toHaveLength(10);
  });
});

describe("benchmark metrics", () => {
  it("scores evidence/citation labels, no-answer and unsupported claims", () => {
    const scored = scoreBenchmarkObservation({
      configurationName: "exact+lexical",
      caseId: "labelled",
      slice: "source-verification",
      rankedDocumentIds: ["doc-a", "noise"],
      goldDocumentIds: ["doc-a"],
      goldEvidenceIds: ["evidence-a"],
      retrievedEvidenceIds: ["evidence-a"],
      goldCitationIds: ["citation-a"],
      retrievedCitationIds: ["citation-a", "citation-noise"],
      returnedAnswer: true,
      latencyMs: 12,
      estimatedTokens: 80,
    });
    expect(scored.recallAt5).toBe(1);
    expect(scored.retrievalRecall).toBe(1);
    expect(scored.evidenceRecall).toBe(1);
    expect(scored.citationPrecision).toBe(0.5);
    expect(scored.evidenceScored).toBe(true);
    expect(scored.citationScored).toBe(true);
    expect(scored.unsupportedClaim).toBe(false);
    expect(scored.latencyMs).toBe(12);
    expect(scored.estimatedTokens).toBe(80);

    const noAnswer = scoreBenchmarkObservation({
      configurationName: "vector-only",
      caseId: "no-answer",
      slice: "no-answer",
      rankedDocumentIds: [],
      goldDocumentIds: [],
      expectNoAnswer: true,
      returnedAnswer: false,
    });
    expect(noAnswer.noAnswerCorrect).toBe(true);
    expect(noAnswer.recallAt10).toBe(1);

    const unsupported = scoreBenchmarkObservation({
      configurationName: "lexical+graph",
      caseId: "unsupported",
      slice: "grounding",
      rankedDocumentIds: ["doc-a"],
      goldDocumentIds: ["doc-a"],
      retrievedEvidenceIds: [],
      returnedAnswer: true,
    });
    expect(unsupported.unsupportedClaim).toBe(true);
  });

  it("scores diagnostic RAG dimensions only when their evidence is supplied", () => {
    const scored = scoreBenchmarkObservation({
      configurationName: "diagnostic",
      caseId: "fully-labelled",
      slice: "diagnostic-rag",
      rankedDocumentIds: ["doc-a", "noise"],
      goldDocumentIds: ["doc-a", "doc-b"],
      contextDocumentIds: ["doc-a", "noise"],
      goldSupportIds: ["support-a", "support-b"],
      retrievedSupportIds: ["support-a"],
      goldCitationIds: ["citation-a"],
      retrievedCitationIds: ["citation-a"],
      usedContextIds: ["doc-a"],
      noiseSensitiveFailure: false,
      faithfulnessScore: 0.8,
      returnedAnswer: true,
    });

    expect(scored).toMatchObject({
      retrievalRecall: 0.5,
      contextPrecision: 0.5,
      claimSupportRecall: 0.5,
      citationPrecision: 1,
      contextUtilization: 0.5,
      noiseSensitivity: 0,
      faithfulness: 0.8,
      contextPrecisionScored: true,
      claimSupportScored: true,
      citationScored: true,
      contextUtilizationScored: true,
      noiseSensitivityScored: true,
      faithfulnessScored: true,
    });

    const unlabelled = scoreBenchmarkObservation({
      configurationName: "diagnostic",
      caseId: "unlabelled",
      slice: "diagnostic-rag",
      rankedDocumentIds: ["doc-a"],
      goldDocumentIds: ["doc-a"],
      returnedAnswer: true,
    });
    expect(unlabelled).toMatchObject({
      contextPrecision: 0,
      claimSupportRecall: 0,
      contextUtilization: 0,
      noiseSensitivity: 0,
      faithfulness: 0,
      contextPrecisionScored: false,
      claimSupportScored: false,
      contextUtilizationScored: false,
      noiseSensitivityScored: false,
      faithfulnessScored: false,
    });
  });

  it("deduplicates repeated document rows before rank metrics", () => {
    const scored = scoreBenchmarkObservation({
      configurationName: "exact+lexical",
      caseId: "duplicate-units",
      slice: "lexical",
      rankedDocumentIds: ["doc-a", "doc-a", "noise"],
      goldDocumentIds: ["doc-a"],
      returnedAnswer: true,
    });
    expect(scored.recallAt10).toBe(1);
    expect(scored.precisionAt10).toBe(0.5);
    expect(scored.reciprocalRank).toBe(1);
  });

  it("aggregates required slices and selects a default only from results", () => {
    const observations = [
      {
        configurationName: "exact+lexical",
        caseId: "exact",
        slice: "exact-identifiers",
        rankedDocumentIds: ["doc-a"],
        goldDocumentIds: ["doc-a"],
        returnedAnswer: true,
        critical: true,
      },
      {
        configurationName: "exact+lexical",
        caseId: "cross-language",
        slice: "cross-language",
        rankedDocumentIds: ["doc-b"],
        goldDocumentIds: ["doc-b"],
        returnedAnswer: true,
        critical: true,
      },
      {
        configurationName: "exact+lexical",
        caseId: "empty",
        slice: "no-answer",
        rankedDocumentIds: [],
        goldDocumentIds: [],
        expectNoAnswer: true,
        returnedAnswer: false,
        critical: true,
      },
    ];
    const run = aggregateBenchmarkRun(
      RETRIEVAL_BENCHMARK_MATRIX[1]!,
      observations,
    );
    expect(run.cases).toBe(3);
    expect(run.criticalFailures).toBe(0);
    expect(run.exactIdentifierRecall).toBe(1);
    expect(run.crossLanguageRecall).toBe(1);
    expect(run.noAnswerAccuracy).toBe(1);
    expect(run.meanRetrievalRecall).toBe(1);
    expect(run.evidenceRecallCoverage).toBe(0);
    expect(run.contextPrecisionCoverage).toBe(0);
    expect(run.claimSupportRecallCoverage).toBe(0);
    expect(run.contextUtilizationCoverage).toBe(0);
    expect(run.noiseSensitivityCoverage).toBe(0);
    expect(run.faithfulnessCoverage).toBe(0);

    const vector = aggregateBenchmarkRun(
      RETRIEVAL_BENCHMARK_MATRIX[8]!,
      observations.map((observation) => ({
        ...observation,
        configurationName: "full-hybrid-rrf",
      })),
    );
    const decision = selectBenchmarkDefault([run, vector]);
    expect(decision.selectedDefault).toBeNull();
    expect(decision.measuredCandidate).toBe("exact+lexical");
    expect(decision.vectorActivatedByDefault).toBe(false);
    expect(decision.baseline).toBe("exact+lexical");
    expect(decision.promotionEligible).toBe(false);
    expect(decision.missingPromotionGates).toEqual([
      "comparableEvaluation",
      "operationalCostAcceptable",
      "degradedBehaviorUnderstood",
      "authorizationTruthPassed",
      "rollbackAvailable",
    ]);

    const promotable = selectBenchmarkDefault([run, vector], {
      comparableEvaluation: true,
      operationalCostAcceptable: true,
      degradedBehaviorUnderstood: true,
      authorizationTruthPassed: true,
      rollbackAvailable: true,
    });
    expect(promotable).toMatchObject({
      selectedDefault: "exact+lexical",
      measuredCandidate: "exact+lexical",
      promotionEligible: true,
      vectorActivatedByDefault: false,
    });
  });

  it("does not select a vector-only or empty benchmark as a runtime default", () => {
    const vectorOnly = aggregateBenchmarkRun(RETRIEVAL_BENCHMARK_MATRIX[2]!, [
      {
        configurationName: "vector-only",
        caseId: "vector-case",
        slice: "conceptual",
        rankedDocumentIds: ["doc-a"],
        goldDocumentIds: ["doc-a"],
        returnedAnswer: true,
      },
    ]);
    expect(selectBenchmarkDefault([vectorOnly])).toMatchObject({
      selectedDefault: null,
      measuredCandidate: null,
      vectorActivatedByDefault: false,
      baseline: null,
      bestVector: "vector-only",
      promotionEligible: false,
    });

    const emptyBaseline = aggregateBenchmarkRun(
      RETRIEVAL_BENCHMARK_MATRIX[1]!,
      [],
    );
    expect(selectBenchmarkDefault([emptyBaseline])).toMatchObject({
      selectedDefault: null,
      measuredCandidate: null,
      baseline: null,
      bestVector: null,
      promotionEligible: false,
    });
  });
});
