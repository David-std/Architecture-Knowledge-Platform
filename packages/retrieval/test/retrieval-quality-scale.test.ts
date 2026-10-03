import { describe, expect, it } from "vitest";
import {
  GENERATED_DISTRACTOR_FAMILIES,
  generatedDistractorFamilyCounts,
} from "../../../evals/generic/retrieval-quality-scale/fixture-db.js";
import {
  classifyQualityScaleOutcome,
  scoreFalseAcceptance,
  scoreGoldRanking,
  validateExperimentContract,
} from "../../../evals/generic/retrieval-quality-scale/metrics.js";

describe("R8 fixed-gold quality metrics", () => {
  it("scores unit recall, reciprocal rank and nDCG from independent labels", () => {
    const metrics = scoreGoldRanking([
      {
        caseId: "first",
        rankedUnitKeys: ["distractor", "gold-a", "gold-b"],
        goldUnitKeys: ["gold-a", "gold-b"],
      },
      {
        caseId: "miss",
        rankedUnitKeys: ["distractor"],
        goldUnitKeys: ["gold-c"],
      },
      {
        caseId: "negative",
        rankedUnitKeys: ["distractor"],
        goldUnitKeys: [],
        expectNoAnswer: true,
      },
    ]);

    expect(metrics.labelledCases).toBe(2);
    expect(metrics.recallAtK["1"]).toBe(0);
    expect(metrics.recallAtK["5"]).toBe(0.5);
    expect(metrics.mrr).toBe(0.25);
    expect(metrics.ndcg).toBeCloseTo(0.3467132018, 8);
  });

  it("keeps false acceptance separate from ranking relevance", () => {
    const metrics = scoreFalseAcceptance([
      {
        caseId: "positive-clean",
        rankedUnitKeys: ["gold"],
        goldUnitKeys: ["gold"],
        admittedUnitKeys: ["gold"],
      },
      {
        caseId: "positive-wrong-unit",
        rankedUnitKeys: ["gold", "wrong"],
        goldUnitKeys: ["gold"],
        admittedUnitKeys: ["gold", "wrong"],
      },
      {
        caseId: "negative-accepted",
        rankedUnitKeys: ["distractor"],
        goldUnitKeys: [],
        expectNoAnswer: true,
        admittedUnitKeys: ["distractor"],
      },
      {
        caseId: "negative-rejected",
        rankedUnitKeys: ["distractor"],
        goldUnitKeys: [],
        expectNoAnswer: true,
        admittedUnitKeys: [],
      },
    ]);

    expect(metrics.falseAcceptances).toBe(2);
    expect(metrics.rate).toBe(0.5);
    expect(metrics.negativeFalseAcceptances).toBe(1);
    expect(metrics.negativeRate).toBe(0.5);
  });

  it("scales every adversarial distractor family with the corpus", () => {
    const targets = [1_000, 10_000, 20_000, 50_000, 100_000];
    let previous = generatedDistractorFamilyCounts(0);
    for (const target of targets) {
      const counts = generatedDistractorFamilyCounts(target);
      expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(
        target,
      );
      for (const family of GENERATED_DISTRACTOR_FAMILIES) {
        expect(counts[family]).toBeGreaterThan(previous[family]);
      }
      previous = counts;
    }
  });

  it("enforces the absolute false-acceptance ceiling at 100K", () => {
    const baseline = {
      recallAt10: 1,
      mrr: 1,
      ndcg: 1,
      falseAcceptanceRate: 0.18,
    };

    expect(
      classifyQualityScaleOutcome({
        baseline,
        final: { ...baseline, falseAcceptanceRate: 0.22 },
        contractComplete: true,
        smoke: false,
      }),
    ).toBe("REJECT");

    expect(
      classifyQualityScaleOutcome({
        baseline,
        final: { ...baseline, falseAcceptanceRate: 0.19 },
        contractComplete: true,
        smoke: false,
      }),
    ).toBe("PROMOTE");
  });

  it("requires every normative experiment contract field", () => {
    const incomplete = validateExperimentContract({ hypothesis: "scale" });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.missingFields).toContain("singleIndependentVariable");

    const complete = validateExperimentContract({
      hypothesis: "fixed gold remains stable as distractors grow",
      failureStage: "CANDIDATE_RETRIEVAL",
      baselineSha: "a".repeat(40),
      candidateSha: "b".repeat(40),
      datasetVersion: "r8-quality-scale-v1",
      datasetHash: "c".repeat(64),
      indexGeneration: "lexical-r8",
      embeddingModelRevision: "disabled",
      rerankerRevision: "disabled",
      readerRevision: "deterministic-admission-v1",
      configurationHash: "d".repeat(64),
      singleIndependentVariable: "distractorCount",
      primaryMetric: "goldUnitRecallAt10",
      guardrailMetrics: ["mrr", "ndcg", "falseAcceptance", "p95QueryLatencyMs"],
      expectedFailureIfWrong:
        "gold unit recall declines or false acceptance rises",
      promotionRule: "full target matrix and no guardrail regression",
      rollback: "discard benchmark result; runtime defaults remain unchanged",
    });
    expect(complete).toEqual({ complete: true, missingFields: [] });
  });
});
