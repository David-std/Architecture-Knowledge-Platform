import { describe, expect, it } from "vitest";
import {
  GENERATED_DISTRACTOR_FAMILIES,
  appendGeneratedDistractors,
  cleanupScaleDatabaseFixture,
  createScaleDatabaseFixture,
  generatedDistractorFamilyCounts,
  logicalKeyForHit,
  materializedFixtureState,
} from "../../../evals/generic/retrieval-quality-scale/fixture-db.js";
import { buildRetrievalScaleStageAttribution } from "../../../evals/generic/retrieval-quality-scale/diagnostics.js";
import {
  classifyQualityScaleOutcome,
  scoreFalseAcceptance,
  scoreGoldRanking,
  validateExperimentContract,
} from "../../../evals/generic/retrieval-quality-scale/metrics.js";
import type { Postgres } from "@akp/postgres";
import type { SearchHit } from "@akp/contracts";
import { assessRetrievalAnswerability } from "../src/answerability.js";
import {
  diagnoseEvidencePipeline,
  evidenceCandidateDiagnostic,
  type EvidenceRetrievalStageSnapshot,
} from "../src/quality-diagnostics.js";

function testHit(documentId: string, unitId: string): SearchHit {
  return {
    documentId,
    unitId,
    vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    document: {
      externalId: `fixture-${documentId.slice(0, 8)}`,
      path: `fixture/${documentId}.md`,
      title: "Approval policy",
    },
    revision: "fixture-revision",
    title: "Approval policy",
    type: "claim",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    unitType: "PARAGRAPH",
    score: 1,
    reasons: ["fixture"],
    fusionContributions: [
      {
        channel: "lexical",
        rank: 1,
        channelWeight: 1,
        rawScore: 1,
        reason: "fixture",
      },
    ],
    excerpt: "The policy requires approval.",
    citations: [],
  };
}

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
    expect(metrics.anyHitAtK["5"]).toBe(0.5);
    expect(metrics.mrr).toBe(0.25);
    expect(metrics.ndcg).toBeCloseTo(0.3467132018, 8);
  });

  it("scores required-unit recall as a fraction and deduplicates nDCG input", () => {
    const metrics = scoreGoldRanking([
      {
        caseId: "multi-unit",
        rankedUnitKeys: ["gold-a", "gold-a"],
        goldUnitKeys: ["gold-a", "gold-b"],
      },
    ]);

    expect(metrics.recallAtK["1"]).toBe(0.5);
    expect(metrics.anyHitAtK["1"]).toBe(1);
    expect(metrics.ndcg).toBe(0.6131471927654584);

    const duplicate = scoreGoldRanking([
      {
        caseId: "duplicate-result",
        rankedUnitKeys: ["gold-a", "gold-a"],
        goldUnitKeys: ["gold-a"],
      },
    ]);
    expect(duplicate.ndcg).toBe(1);
  });

  it("deduplicates before every cutoff used by recall and any-hit", () => {
    const metrics = scoreGoldRanking(
      [
        {
          caseId: "duplicate-prefix",
          rankedUnitKeys: ["wrong", "wrong", "gold-a", "gold-b"],
          goldUnitKeys: ["gold-a", "gold-b", "gold-a"],
        },
      ],
      [2, 3],
    );

    expect(metrics.recallAtK["2"]).toBe(0.5);
    expect(metrics.anyHitAtK["2"]).toBe(1);
    expect(metrics.recallAtK["3"]).toBe(1);
    expect(metrics.anyHitAtK["3"]).toBe(1);
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

    expect(metrics.outsideClosedGoldAdmissions).toBe(2);
    expect(metrics.outsideClosedGoldRate).toBe(0.5);
    expect(metrics.negativeFalseAcceptances).toBe(1);
    expect(metrics.negativeFalseAcceptanceRate).toBe(0.5);
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

  it("gates promotion on explicit no-answer false acceptance", () => {
    const baseline = {
      recallAt10: 1,
      mrr: 1,
      ndcg: 1,
      negativeCases: 4,
      negativeFalseAcceptanceRate: 0.18,
    };

    expect(
      classifyQualityScaleOutcome({
        baseline,
        final: { ...baseline, negativeFalseAcceptanceRate: 0.22 },
        contractComplete: true,
        reducedScope: false,
      }),
    ).toBe("REJECT");

    expect(
      classifyQualityScaleOutcome({
        baseline,
        final: { ...baseline, negativeFalseAcceptanceRate: 0.19 },
        contractComplete: true,
        reducedScope: false,
      }),
    ).toBe("PROMOTE");

    expect(
      classifyQualityScaleOutcome({
        baseline: { ...baseline, negativeCases: 1 },
        final: baseline,
        contractComplete: true,
        reducedScope: false,
      }),
    ).toBe("INCONCLUSIVE");
  });

  it("requires every normative experiment contract field", () => {
    const incomplete = validateExperimentContract({ hypothesis: "scale" });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.missingFields).toContain("singleIndependentVariable");

    const complete = validateExperimentContract({
      hypothesis: "fixed gold remains stable as distractors grow",
      failureStage: "CANDIDATE_NOT_RETRIEVED",
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
      primaryMetric: "goldUnitFractionRecallAt10",
      guardrailMetrics: [
        "mrr",
        "ndcg",
        "falseAcceptance",
        "ADMISSION_FALSE_POSITIVE",
        "p95QueryLatencyMs",
      ],
      expectedFailureIfWrong:
        "gold unit recall declines or false acceptance rises",
      promotionRule: "full target matrix and no guardrail regression",
      rollback: "discard benchmark result; runtime defaults remain unchanged",
    });
    expect(complete).toEqual({ complete: true, missingFields: [] });
  });

  it("classifies admission losses while leaving unobserved stages explicit", () => {
    const expected = [
      {
        documentId: "doc-gold",
        unitId: "unit-gold",
        evidenceSpan: { startOffset: 4, endOffset: 9 },
      },
    ];
    const candidate = {
      documentId: "doc-gold",
      unitId: "unit-gold",
      rank: 1,
      score: 1,
      unitType: "RULE",
      channels: [],
      authorization: null,
      truth: null,
      temporal: null,
      rerank: null,
      admission: {
        accepted: false,
        decision: "INSUFFICIENT",
        span: null,
        spanIntegrity: "NOT_MEASURED" as const,
        readerSelected: null,
      },
    };
    const admissionFn = diagnoseEvidencePipeline({
      caseId: "admission-fn",
      measurement: "RETRIEVAL_PIPELINE",
      expected,
      admissible: expected,
      labelsComplete: true,
      sourceDocuments: ["doc-gold"],
      materializedUnits: [{ documentId: "doc-gold", unitId: "unit-gold" }],
      channelCandidates: [{ documentId: "doc-gold", unitId: "unit-gold" }],
      candidates: [candidate],
      beforeRerank: [candidate],
      reranked: [candidate],
      shortlist: [{ documentId: "doc-gold", unitId: "unit-gold" }],
      admitted: [],
    });
    expect(admissionFn.failures.map((failure) => failure.stage)).toEqual([
      "ADMISSION_FALSE_NEGATIVE",
    ]);
    expect(admissionFn.measuredStages.context).toBe(false);
    expect(admissionFn.measuredStages.generation).toBe(false);

    const admissionFp = diagnoseEvidencePipeline({
      caseId: "admission-fp",
      measurement: "RETRIEVAL_PIPELINE",
      expected,
      admissible: expected,
      labelsComplete: true,
      sourceDocuments: ["doc-gold"],
      materializedUnits: [{ documentId: "doc-gold", unitId: "unit-gold" }],
      admitted: [
        {
          ...candidate,
          documentId: "doc-wrong",
          unitId: "unit-wrong",
          admission: { ...candidate.admission, accepted: true },
        },
      ],
    });
    expect(admissionFp.failures.map((failure) => failure.stage)).toEqual([
      "ADMISSION_FALSE_POSITIVE",
    ]);
  });

  it("builds stage attribution from returned-hit diagnostics and fails closed on a missing sink", () => {
    const goldHit = testHit(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    const wrongHit = testHit(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    );
    const returnedHits = [goldHit, wrongHit];
    const assessment = assessRetrievalAnswerability(
      returnedHits,
      "policy requires approval",
    );
    const stageCandidate = (hit: SearchHit, rank: number) =>
      evidenceCandidateDiagnostic(hit, rank);
    const snapshot: EvidenceRetrievalStageSnapshot = {
      channelCandidates: returnedHits.map(({ documentId, unitId }) => ({
        documentId,
        unitId: unitId ?? null,
      })),
      fusedCandidates: returnedHits.map(stageCandidate),
      beforeRerank: returnedHits.map(stageCandidate),
      afterRerank: returnedHits.map(stageCandidate),
      returned: returnedHits.map(({ documentId, unitId }) => ({
        documentId,
        unitId: unitId ?? null,
      })),
    };
    const expected = [
      {
        documentId: goldHit.documentId,
        unitId: goldHit.unitId!,
        evidenceSpan: { startOffset: 0, endOffset: 6 },
      },
    ];
    const attributed = buildRetrievalScaleStageAttribution({
      caseId: "live-seam",
      expected,
      admissible: [{ documentId: goldHit.documentId, unitId: goldHit.unitId! }],
      labelsComplete: false,
      labelScope: "CLOSED_GOLD_BENCHMARK",
      sourceDocuments: [goldHit.documentId, wrongHit.documentId],
      materializedUnits: returnedHits.map(({ documentId, unitId }) => ({
        documentId,
        unitId: unitId!,
      })),
      snapshot,
      returnedHits,
      assessment,
      shortlistLimit: 2,
    });

    expect(attributed.candidateTrace).toHaveLength(2);
    expect(
      attributed.candidateTrace.every(
        (candidate) => candidate.admission !== null,
      ),
    ).toBe(true);
    expect(attributed.admitted).toHaveLength(2);
    expect(attributed.admittedOutsideAdmissible).toHaveLength(1);
    expect(attributed.labelsComplete).toBe(false);
    expect(attributed.labelScope).toBe("CLOSED_GOLD_BENCHMARK");
    expect(
      attributed.admitted?.map((candidate) => candidate.documentId),
    ).toEqual(
      expect.arrayContaining([goldHit.documentId, wrongHit.documentId]),
    );
    expect(attributed.failures.map((failure) => failure.stage)).not.toContain(
      "ADMISSION_FALSE_POSITIVE",
    );
    expect(attributed.measuredStages.context).toBe(false);
    expect(attributed.measuredStages.generation).toBe(false);

    const noAnswer = buildRetrievalScaleStageAttribution({
      caseId: "no-answer-seam",
      expected: [],
      admissible: [],
      labelsComplete: true,
      labelScope: "CLOSED_GOLD_BENCHMARK",
      sourceDocuments: [goldHit.documentId, wrongHit.documentId],
      materializedUnits: returnedHits.map(({ documentId, unitId }) => ({
        documentId,
        unitId: unitId!,
      })),
      snapshot,
      returnedHits,
      assessment,
      shortlistLimit: 2,
    });

    expect(noAnswer.labelsComplete).toBe(true);
    expect(noAnswer.admitted).toHaveLength(2);
    expect(noAnswer.admittedOutsideAdmissible).toHaveLength(2);
    expect(noAnswer.failures.map((failure) => failure.stage)).toEqual([
      "ADMISSION_FALSE_POSITIVE",
      "ADMISSION_FALSE_POSITIVE",
    ]);
    expect(
      noAnswer.failures.map((failure) => ({
        documentId: failure.target?.documentId,
        unitId: failure.target?.unitId,
        evidenceSpan: failure.target?.evidenceSpan,
      })),
    ).toEqual([
      {
        documentId: goldHit.documentId,
        unitId: goldHit.unitId,
        evidenceSpan: null,
      },
      {
        documentId: wrongHit.documentId,
        unitId: wrongHit.unitId,
        evidenceSpan: null,
      },
    ]);
    expect(noAnswer.exactSpanEvaluation).toEqual({
      annotatedGoldUnits: 0,
      totalGoldUnits: 0,
      precision: null,
    });

    expect(() =>
      buildRetrievalScaleStageAttribution({
        caseId: "missing-seam",
        expected,
        admissible: [
          { documentId: goldHit.documentId, unitId: goldHit.unitId! },
        ],
        labelsComplete: false,
        labelScope: "CLOSED_GOLD_BENCHMARK",
        sourceDocuments: [goldHit.documentId],
        materializedUnits: [
          { documentId: goldHit.documentId, unitId: goldHit.unitId! },
        ],
        snapshot: undefined,
        returnedHits: [goldHit],
        assessment,
        shortlistLimit: 2,
      }),
    ).toThrow("R8_STAGE_SNAPSHOT_MISSING:missing-seam");
  });

  it("derives generated distractor identities from seed and ordinal instead of random UUIDs", async () => {
    const fixture = createScaleDatabaseFixture("deterministic-generated-ids");
    fixture.vaultIds.set("gold", "00000000-0000-4000-8000-000000000101");
    fixture.vaultIds.set("other-vault", "00000000-0000-4000-8000-000000000102");
    const sql: string[] = [];
    const fakeDb = {
      pool: {
        query: async (statement: string) => {
          sql.push(statement);
          return { rows: [] };
        },
      },
    } as unknown as Postgres;

    await appendGeneratedDistractors(fakeDb, fixture, 7);

    expect(sql[0]).toContain(
      "md5($6::text || ':generated-document:' || ordinal::text)",
    );
    expect(sql[0]).toContain(
      "md5($6::text || ':generated-unit:' || external_id)",
    );
    expect(sql[0]).not.toContain("gen_random_uuid()");
  });

  it("reads only fixed source and unit identities from the live database projection", async () => {
    const fixture = createScaleDatabaseFixture("materialized-state");
    fixture.documentIds.set("gold", "00000000-0000-4000-8000-000000000001");
    fixture.documentIds.set(
      "without-unit",
      "00000000-0000-4000-8000-000000000002",
    );
    fixture.unitIds.set(
      "gold:paragraph",
      "00000000-0000-4000-8000-000000000011",
    );
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const fakeDb = {
      pool: {
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          return sql.includes("from knowledge_documents")
            ? {
                rows: [
                  { document_id: "doc-gold" },
                  { document_id: "doc-without-unit" },
                ],
              }
            : {
                rows: [{ document_id: "doc-gold", unit_id: "unit-gold" }],
              };
        },
      },
    } as unknown as Postgres;

    await expect(materializedFixtureState(fakeDb, fixture)).resolves.toEqual({
      sourceDocuments: ["doc-gold", "doc-without-unit"],
      units: [{ documentId: "doc-gold", unitId: "unit-gold" }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.values[1]).toEqual([...fixture.documentIds.values()]);
    expect(calls[1]?.values[1]).toEqual([...fixture.unitIds.values()]);
  });

  it("does not hide cleanup count verification failures as zero rows", async () => {
    const fixture = createScaleDatabaseFixture("cleanup-verification");
    const fakeDb = {
      pool: {
        query: async (sql: string) => {
          if (sql.trimStart().startsWith("select")) {
            throw new Error("verification query unavailable");
          }
          return { rows: [] };
        },
      },
    } as unknown as Postgres;

    await expect(cleanupScaleDatabaseFixture(fakeDb, fixture)).rejects.toThrow(
      "verification query unavailable",
    );
  });

  it("keeps unresolved generated candidates distinct for ranking metrics", () => {
    const fixture = createScaleDatabaseFixture("logical-key-distinctness");
    expect(
      logicalKeyForHit(
        fixture,
        "00000000-0000-4000-8000-000000000001",
        "unit-a",
      ),
    ).not.toBe(
      logicalKeyForHit(
        fixture,
        "00000000-0000-4000-8000-000000000002",
        "unit-b",
      ),
    );
  });
});
