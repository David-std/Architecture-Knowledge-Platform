import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  diagnoseEvidencePipeline,
  evidenceCandidateDiagnostic,
  type EvidencePipelineObservation,
  type GoldEvidenceTarget,
} from "../src/quality-diagnostics.js";
import {
  retrievalAnswerabilityCandidateKey,
  type CandidateAnswerabilitySignal,
} from "../src/answerability.js";
import {
  buildContextPacket,
  type ContextSelectionDiagnostic,
} from "../src/context-packet.js";
import {
  evaluateEvidenceAdmission,
  loadEvidenceAdmissionPack,
} from "../../../scripts/evidence-admission-pack.js";

const hit: SearchHit = {
  documentId: "11111111-1111-4111-8111-111111111111",
  unitId: "22222222-2222-4222-8222-222222222222",
  vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  document: {
    externalId: "private-identity",
    path: "private/path.md",
    title: "Private title",
  },
  revision: "revision-1",
  title: "Private title",
  type: "claim",
  trust: "HUMAN_REVIEWED",
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  unitType: "PARAGRAPH",
  score: 0.25,
  reasons: ["private-query-marker"],
  excerpt: "Private passage bytes must not enter diagnostic telemetry.",
  citations: ["private/citation"],
  fusionContributions: [
    {
      channel: "lexical",
      rank: 1,
      channelWeight: 1.5,
      rawScore: 4,
      reason: "private-query-marker",
    },
  ],
};
const target: GoldEvidenceTarget = {
  documentId: hit.documentId,
  unitId: hit.unitId!,
  evidenceSpan: { startOffset: 0, endOffset: 7 },
};
const candidate = evidenceCandidateDiagnostic(hit, 1);

function observation(
  overrides: Partial<EvidencePipelineObservation> = {},
): EvidencePipelineObservation {
  return {
    caseId: "case-1",
    measurement: "RETRIEVAL_PIPELINE",
    expected: [target],
    admissible: [target],
    labelsComplete: true,
    sourceDocuments: [target.documentId],
    materializedUnits: [target],
    channelCandidates: [target],
    candidates: [candidate],
    beforeRerank: [candidate],
    reranked: [candidate],
    shortlist: [target],
    shortlistLimit: 2,
    admitted: [candidate],
    context: [target],
    ...overrides,
  };
}

const stages = (input: EvidencePipelineObservation) =>
  diagnoseEvidencePipeline(input).failures.map((failure) => failure.stage);

describe("evidence pipeline loss attribution", () => {
  it.each([
    [{ sourceDocuments: [] }, "INGESTION_MISSING"],
    [{ materializedUnits: [] }, "UNITIZATION_BAD"],
    [
      { channelCandidates: [], candidates: [], beforeRerank: [], admitted: [] },
      "CANDIDATE_NOT_RETRIEVED",
    ],
    [
      { candidates: [], beforeRerank: [], admitted: [] },
      "CANDIDATE_RANKED_TOO_LOW",
    ],
    [{ beforeRerank: [], admitted: [] }, "CANDIDATE_RANKED_TOO_LOW"],
    [{ admitted: [] }, "ADMISSION_FALSE_NEGATIVE"],
    [
      {
        context: [],
        contextOmissions: [{ ...target, reason: "TOKEN_BUDGET" }],
      },
      "CONTEXT_BUDGET_DROPPED",
    ],
    [
      {
        context: [],
        contextOmissions: [{ ...target, reason: "MISSING_EVIDENCE" }],
      },
      "SPAN_INVALID",
    ],
  ] as const)("identifies the first measured loss: %s", (overrides, stage) => {
    expect(stages(observation(overrides))).toEqual([stage]);
  });

  it("distinguishes rerank loss from an already low-ranked gold unit", () => {
    const post = { ...candidate, rank: 5 };
    expect(
      stages(observation({ reranked: [post], shortlist: [], admitted: [] })),
    ).toEqual(["RERANK_DROPPED_GOLD"]);
    expect(
      stages(
        observation({
          beforeRerank: [post],
          reranked: [post],
          shortlist: [],
          admitted: [],
        }),
      ),
    ).toEqual(["CANDIDATE_RANKED_TOO_LOW"]);
  });

  it("does not blame retrieval when upstream unit or channel observations are missing", () => {
    const report = diagnoseEvidencePipeline(
      observation({
        materializedUnits: undefined,
        channelCandidates: undefined,
        candidates: [],
        admitted: [],
      }),
    );
    expect(report.failures).toEqual([]);
    expect(report.unresolved).toHaveLength(1);
    expect(report.measuredStages.unitization).toBe(false);
    expect(report.measuredStages.channels).toBe(false);
  });

  it("requires supplied admission candidates to contain the labeled gold unit", () => {
    expect(() =>
      diagnoseEvidencePipeline(
        observation({
          measurement: "SUPPLIED_CANDIDATE_ADMISSION",
          candidates: [],
        }),
      ),
    ).toThrow("ADMISSION_GOLD_NOT_IN_SUPPLIED_CANDIDATES");
  });

  it("keeps same-document sibling units distinct at every boundary", () => {
    const sibling = {
      ...candidate,
      unitId: "33333333-3333-4333-8333-333333333333",
    };
    const report = diagnoseEvidencePipeline(
      observation({ admitted: [sibling] }),
    );
    expect(report.failures.map((failure) => failure.stage)).toEqual([
      "ADMISSION_FALSE_NEGATIVE",
      "ADMISSION_FALSE_POSITIVE",
    ]);
    expect(report.admittedUnitPrecision).toBe(0);
  });

  it("never fabricates precision from incomplete labels or an empty denominator", () => {
    expect(
      diagnoseEvidencePipeline(observation({ labelsComplete: false }))
        .admittedUnitPrecision,
    ).toBeNull();
    expect(
      diagnoseEvidencePipeline(observation({ admitted: [] }))
        .admittedUnitPrecision,
    ).toBeNull();
    expect(
      diagnoseEvidencePipeline(observation()).exactSpanEvaluation.precision,
    ).toBeNull();
  });

  it("does not report an exact-channel admission as a reader shortlist miss", () => {
    expect(stages(observation({ shortlist: [] }))).toEqual([]);
  });

  it("requires context observation before attributing a wrong answer to generation", () => {
    expect(
      stages(
        observation({ generation: { correct: false, unsupportedClaims: 0 } }),
      ),
    ).toEqual(["GENERATION_FAILURE"]);
    expect(
      stages(
        observation({
          context: undefined,
          generation: { correct: false, unsupportedClaims: 0 },
        }),
      ),
    ).toEqual([]);
    expect(
      stages(
        observation({
          expected: [],
          generation: { correct: false, unsupportedClaims: 1 },
        }),
      ),
    ).toEqual(["GENERATOR_UNSUPPORTED_CLAIM"]);
  });
});

describe("metadata-only evidence diagnostics", () => {
  it("retains channel scores and ranks without query, path, title or passage text", () => {
    const serialized = JSON.stringify(evidenceCandidateDiagnostic(hit, 1));
    for (const value of [
      hit.excerpt,
      hit.title,
      hit.document.path,
      hit.document.externalId!,
      ...hit.reasons,
      ...hit.citations,
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(candidate.channels[0]).toMatchObject({
      channel: "lexical",
      rank: 1,
      rawScore: 4,
      fusionContribution: 1.5 / 61,
    });
  });

  it("reports non-verbatim reader quotes as span failures rather than semantic rejection", () => {
    const traced = evidenceCandidateDiagnostic(hit, 1, {
      supportedCandidateKeys: [],
      candidateSignals: [
        {
          candidateKey: retrievalAnswerabilityCandidateKey(hit),
          queryConditionedEvidence: {
            verifierId: "test-reader",
            mode: "ENFORCE",
            decision: "INSUFFICIENT",
            score: 0.8,
            reason: "READER_QUOTE_NOT_IN_PASSAGE",
            evidenceSpan: null,
          },
        } as CandidateAnswerabilitySignal,
      ],
    });
    expect(stages(observation({ candidates: [traced], admitted: [] }))).toEqual(
      ["SPAN_INVALID"],
    );
  });

  it("rejects hidden or out-of-bounds span integrity without changing admission", () => {
    const hiddenHit = { ...hit, excerpt: "Visible. <!-- Hidden. -->" };
    const diagnostic = evidenceCandidateDiagnostic(hiddenHit, 1, {
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(hiddenHit)],
      candidateSignals: [
        {
          candidateKey: retrievalAnswerabilityCandidateKey(hiddenHit),
          queryConditionedEvidence: {
            verifierId: "test-reader",
            mode: "ENFORCE",
            decision: "SUPPORTS",
            score: 1,
            reason: "test",
            evidenceSpan: { startOffset: 9, endOffset: 25 },
          },
        } as CandidateAnswerabilitySignal,
      ],
    });
    expect(diagnostic.admission?.accepted).toBe(true);
    expect(diagnostic.admission?.spanIntegrity).toBe("INVALID");
    expect(stages(observation({ admitted: [diagnostic] }))).toEqual([
      "SPAN_INVALID",
    ]);
  });

  it("distinguishes context token budget, document caps and missing citations", () => {
    const request = {
      query: "opaque",
      spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      vaultId: hit.vaultId,
      vaultIds: [],
      federated: false,
      types: [],
      minimumTrust: "MACHINE_SUPPORTED" as const,
      mode: "SOURCE_BACKED" as const,
      limit: 20,
    };
    let trace: ContextSelectionDiagnostic | undefined;
    buildContextPacket({
      request,
      intent: "CONCEPTUAL",
      corpusRevision: "test",
      maxTokens: 2500,
      candidates: [
        { hit, content: "Private passage. ".repeat(5000), kind: "evidence" },
      ],
      selectionDiagnosticSink: (value) => {
        trace = value;
      },
    });
    expect(trace?.omitted[0]?.reason).toBe("TOKEN_BUDGET");
    expect(JSON.stringify(trace)).not.toContain("Private passage");
    buildContextPacket({
      request,
      intent: "SOURCE_VERIFICATION",
      corpusRevision: "test",
      maxTokens: 2500,
      candidates: [
        {
          hit: { ...hit, citations: [] },
          content: hit.excerpt,
          kind: "evidence",
        },
      ],
      selectionDiagnosticSink: (value) => {
        trace = value;
      },
    });
    expect(trace?.omitted[0]?.reason).toBe("MISSING_EVIDENCE");
    buildContextPacket({
      request,
      intent: "CONCEPTUAL",
      corpusRevision: "test",
      maxTokens: 10000,
      maxSectionsPerDocument: 1,
      candidates: [
        candidate,
        { ...candidate, unitId: "33333333-3333-4333-8333-333333333333" },
      ].map((identity) => ({
        hit: { ...hit, unitId: identity.unitId! },
        content: hit.excerpt,
        kind: "evidence" as const,
      })),
      selectionDiagnosticSink: (value) => {
        trace = value;
      },
    });
    expect(trace?.selected).toHaveLength(1);
    expect(trace?.omitted[0]?.reason).toBe("DOCUMENT_SECTION_LIMIT");
  });

  it("keeps legacy admission outcomes identical while adding unit loss diagnostics", async () => {
    const { cases } = await loadEvidenceAdmissionPack(["development"]);
    const entry = cases.find((row) => row.question.gold.length === 1)!;
    const legacy = await evaluateEvidenceAdmission([entry], async () => []);
    const traced = await evaluateEvidenceAdmission([entry], async () => ({
      supportedCandidateKeys: [],
      candidateSignals: [],
    }));
    expect(traced[0]?.admitted).toEqual(legacy[0]?.admitted);
    expect(traced[0]?.strictCorrect).toBe(legacy[0]?.strictCorrect);
    expect(traced[0]?.stageDiagnostics.failures[0]?.stage).toBe(
      "ADMISSION_FALSE_NEGATIVE",
    );
    expect(traced[0]?.stageDiagnostics.measuredStages.ingestion).toBe(false);
    expect(
      traced[0]?.stageDiagnostics.exactSpanEvaluation.annotatedGoldUnits,
    ).toBe(0);
  });
});
