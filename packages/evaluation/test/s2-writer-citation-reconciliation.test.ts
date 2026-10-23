import { describe, expect, it } from "vitest";
import { reconcileS2WriterCitations } from "../src/s2-writer-citation-reconciliation.js";
import type { NativeWriterObservation } from "../src/s2-native-structured-writer.js";
import type { S2SemanticEvidenceAssessment } from "../src/s2-semantic-evidence.js";
import type { S2ReviewedWriterCitation } from "../src/s2-writer-citation-reconciliation.js";

const writer: NativeWriterObservation = {
  schemaVersion: "akp.s2.local-native-writer-observation.v1",
  status: "STRUCTURALLY_VALID",
  reason: "EXACT_SCHEMA_AND_IDS_ONLY",
  requestSha256: "1".repeat(64),
  responseSha256: "2".repeat(64),
  promptTokens: 218,
  completionTokens: 36,
  requestedContextTokens: 8192,
  finishReason: "stop",
  answerText: "The named option is mercury.",
  citations: ["SRC1", "SRC2"],
  abstained: false,
  modelCitationSemanticsVerified: false,
  sourceNegativeAbsenceVerified: false,
  effectiveFullSourceContextVerified: false,
  applicationP95Measured: false,
  gateAccepted: false,
};
function assessment(
  id: string,
  status: S2SemanticEvidenceAssessment["status"] = "SUPPORTED_CANDIDATE",
): S2SemanticEvidenceAssessment {
  return {
    status,
    reason: "TWO_STAGE_SEMANTIC_SUPPORT_CANDIDATE",
    attribution: {
      status: "VERBATIM_UNIQUE_SOURCE_BOUND",
      reason: "MODEL_SOURCE_ID_AND_QUOTE_BOUND",
      assignedSourceId: id,
      modelSourceId: id,
      sourceSha256: "c".repeat(64),
      startUtf16: 50,
      endUtf16: 100,
      modelSourceIdConfirmed: true,
      modelSourceIdRepairedByLiteralProof: false,
      semanticEntailmentVerified: false,
      releaseGateAccepted: false,
    },
    questionRelevance: {
      decision: "SUPPORTS",
      reason: "QUESTION_FOCUS_BOUND",
      evidenceSpan: { startUtf16: 0, endUtf16: 20 },
    },
    claimEntailment: {
      decision: "SUPPORTS",
      reason: "CLAIM_BOUND",
      evidenceSpan: { startUtf16: 0, endUtf16: 20 },
    },
    questionProbeId: "qa@pinned",
    claimProbeId: "nli@pinned",
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}
const paired = (): S2ReviewedWriterCitation[] => [
  { citationId: "SRC1", assessment: assessment("SRC1") },
  { citationId: "SRC2", assessment: assessment("SRC2") },
];

describe("shadow native-writer to F3 citation reconciliation", () => {
  it("retains candidate status only when every cited source is bound and proposed support", () => {
    const result = reconcileS2WriterCitations(writer, paired());
    expect(result).toEqual({
      status: "SOURCE_BOUND_CANDIDATE",
      reason: "ALL_CITED_SOURCES_PROPOSE_SUPPORT",
      sourceBoundCitations: 2,
      requiredCitations: 2,
      completeAnswerVerified: false,
      independentSemanticReviewVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
  });
  it("fails closed when a related but nonanswering citation accompanies a good one", () => {
    const reviews = paired();
    reviews[1] = {
      citationId: "SRC2",
      assessment: assessment("SRC2", "INSUFFICIENT"),
    };
    expect(reconcileS2WriterCitations(writer, reviews).status).toBe(
      "WITHHELD_UNSUPPORTED_CITATION",
    );
  });
  it("treats an explicit contradiction as a veto", () => {
    const reviews = paired();
    reviews[1] = {
      citationId: "SRC2",
      assessment: assessment("SRC2", "CONTRADICTED"),
    };
    expect(reconcileS2WriterCitations(writer, reviews).status).toBe(
      "WITHHELD_CONTRADICTION",
    );
  });
  it("rejects missing, duplicated, foreign and repaired citation references", () => {
    expect(
      reconcileS2WriterCitations(writer, paired().slice(0, 1)).status,
    ).toBe("STRUCTURALLY_REJECTED");
    expect(
      reconcileS2WriterCitations(writer, [paired()[0]!, paired()[0]!]).status,
    ).toBe("STRUCTURALLY_REJECTED");
    const different = paired();
    different[1] = { citationId: "SRC3", assessment: assessment("SRC3") };
    expect(reconcileS2WriterCitations(writer, different).status).toBe(
      "STRUCTURALLY_REJECTED",
    );
    const base = assessment("SRC2");
    const repaired: S2SemanticEvidenceAssessment = {
      ...base,
      attribution: {
        ...base.attribution,
        modelSourceIdConfirmed: false,
        modelSourceIdRepairedByLiteralProof: true,
      },
    };
    expect(
      reconcileS2WriterCitations(writer, [
        paired()[0]!,
        { citationId: "SRC2", assessment: repaired },
      ]).status,
    ).toBe("STRUCTURALLY_REJECTED");
  });
  it("rejects a fabricated aggregate SUPPORT without independently bound stage observations", () => {
    const first = assessment("SRC1");
    const second = assessment("SRC2");
    const missing: S2SemanticEvidenceAssessment = {
      ...second,
      questionRelevance: null,
    };
    expect(
      reconcileS2WriterCitations(writer, [
        { citationId: "SRC1", assessment: first },
        { citationId: "SRC2", assessment: missing },
      ]),
    ).toMatchObject({
      status: "STRUCTURALLY_REJECTED",
      reason: "SEMANTIC_STAGES_NOT_SOURCE_BOUND",
    });
    const outside: S2SemanticEvidenceAssessment = {
      ...second,
      claimEntailment: {
        decision: "SUPPORTS",
        reason: "MODEL_SUPPORT",
        evidenceSpan: { startUtf16: 0, endUtf16: 99999 },
      },
    };
    expect(
      reconcileS2WriterCitations(writer, [
        { citationId: "SRC1", assessment: first },
        { citationId: "SRC2", assessment: outside },
      ]).status,
    ).toBe("STRUCTURALLY_REJECTED");
  });
  it("does not reinterpret a structural failure as valid support", () => {
    expect(
      reconcileS2WriterCitations({ ...writer, status: "REJECTED" }, paired())
        .status,
    ).toBe("STRUCTURALLY_REJECTED");
  });
  it("classifies an empty writer abstention as unverified rather than correct", () => {
    const result = reconcileS2WriterCitations(
      { ...writer, answerText: "", citations: [], abstained: true },
      [],
    );
    expect(result.status).toBe("ABSTENTION_UNVERIFIED");
    expect(result.completeAnswerVerified).toBe(false);
  });
});
