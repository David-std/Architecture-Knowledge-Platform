import { describe, expect, it } from "vitest";
import {
  RETRIEVAL_BENCHMARK_MATRIX,
  aggregateBenchmarkRun,
  scoreBenchmarkObservation,
  selectBenchmarkDefault,
} from "../src/index.js";

describe("retrieval benchmark matrix", () => {
  it("contains exactly the ten required, auditable configurations", () => {
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
    ]);
    expect(RETRIEVAL_BENCHMARK_MATRIX).toHaveLength(10);
    expect(
      RETRIEVAL_BENCHMARK_MATRIX.filter(({ channels }) =>
        channels.includes("vector"),
      ).every(({ allowVectorForBenchmark }) => allowVectorForBenchmark),
    ).toBe(true);
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
    expect(run.evidenceRecallCoverage).toBe(0);

    const vector = aggregateBenchmarkRun(
      RETRIEVAL_BENCHMARK_MATRIX[8]!,
      observations.map((observation) => ({
        ...observation,
        configurationName: "full-hybrid-rrf",
      })),
    );
    const decision = selectBenchmarkDefault([run, vector]);
    expect(decision.selectedDefault).toBe("exact+lexical");
    expect(decision.vectorActivatedByDefault).toBe(false);
    expect(decision.baseline).toBe("exact+lexical");
  });
});
