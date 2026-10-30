import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  traceS2SemanticPipeline,
  type S2SemanticPipelineTraceInput,
} from "../src/s2-semantic-pipeline-trace.js";
const source = {
  status: "VERBATIM_UNIQUE_SOURCE_BOUND",
  sourceSha256: "1".repeat(64),
  startUtf16: 0,
  endUtf16: 30,
};
type MutableTraceInput = {
  -readonly [
    K in keyof S2SemanticPipelineTraceInput
  ]: S2SemanticPipelineTraceInput[K];
};
function fixture(): MutableTraceInput {
  const originalQuestion = "Which object grants permission?";
  const questionAnswerSha256 = createHash("sha256")
    .update(originalQuestion)
    .update(Buffer.from([0]))
    .update("the access proxy")
    .digest("hex");
  return {
    originalQuestion,
    writer: {
      status: "STRUCTURALLY_VALID",
      abstained: false,
      answerText: "the access proxy",
      citations: ["SRC1"],
    } as never,
    projection: {
      status: "CLAIM_CANDIDATE",
      claimText: "The access proxy grants permission.",
      questionAnswerSha256,
      roleDecision: "MATCH",
    } as never,
    claimSemantics: {
      status: "SUPPORTED_CANDIDATE",
      attribution: source,
      questionRelevance: { decision: "SUPPORTS" },
      claimEntailment: { decision: "SUPPORTS" },
    } as never,
    citations: { status: "SOURCE_BOUND_CANDIDATE" } as never,
    wholeAnswer: { status: "COMPLETE_SUPPORTED_CANDIDATE" } as never,
  };
}
describe("semantic pipeline evidence-lineage diagnostics", () => {
  it("never promotes even an entirely positive shadow trace", () => {
    expect(traceS2SemanticPipeline(fixture())).toMatchObject({
      status: "SHADOW_CANDIDATE_NOT_RELEASE",
      firstUnprovenStage: null,
      sourceBoundUtf16Observed: true,
      completeAnswerCandidateObserved: true,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
  });
  it("locates provider-schema failure rather than misdiagnosing it as F3", () => {
    const f = fixture();
    f.writer = {
      status: "REJECTED",
      reason: "ABSTENTION_AND_EVIDENCE_CONFLICT",
    } as never;
    const out = traceS2SemanticPipeline(f);
    expect(out).toMatchObject({
      status: "WRITER_CONTRACT_REJECTED",
      firstUnprovenStage: "WRITER",
      stageStatuses: {
        writer: "REJECTED",
        claim: "SUPPORTS",
      },
    });
  });
  it("does not equate clean abstention to verified absence", () => {
    const f = fixture();
    f.writer = {
      status: "STRUCTURALLY_VALID",
      abstained: true,
      answerText: "",
      citations: [],
    } as never;
    expect(traceS2SemanticPipeline(f)).toMatchObject({
      status: "ABSTENTION_NOT_ADJUDICATED",
      firstUnprovenStage: "WRITER",
    });
  });
  it("stops at missing or malformed projection despite a positive claim model", () => {
    const f = fixture();
    f.projection = { status: "INSUFFICIENT", claimText: null } as never;
    expect(traceS2SemanticPipeline(f).status).toBe("PROJECTION_FAILED");
    f.projection = null;
    expect(traceS2SemanticPipeline(f).status).toBe("PROJECTION_NOT_OBSERVED");
  });
  it("catches cross-case or altered writer-answer projection replays before the semantic model", () => {
    const f = fixture();
    f.writer = {
      ...f.writer,
      answerText: "the administrator",
    } as never;
    expect(traceS2SemanticPipeline(f)).toMatchObject({
      status: "PROJECTION_INPUT_BINDING_MISMATCH",
      firstUnprovenStage: "PROJECTION",
      productionAdmission: false,
      stageStatuses: { claim: "SUPPORTS" },
    });
    const other = fixture();
    other.originalQuestion = "Who grants permission?";
    expect(traceS2SemanticPipeline(other).status).toBe(
      "PROJECTION_INPUT_BINDING_MISMATCH",
    );
  });
  it("does not accept source-free or invalid UTF-16 attribution", () => {
    const f = fixture();
    f.claimSemantics = {
      ...f.claimSemantics,
      attribution: { ...source, endUtf16: -2 },
    } as never;
    expect(traceS2SemanticPipeline(f)).toMatchObject({
      firstUnprovenStage: "SOURCE",
      sourceBoundUtf16Observed: false,
    });
  });
  it("keeps question-role disputes separate from claim support", () => {
    const f = fixture();
    f.claimSemantics = {
      ...f.claimSemantics,
      status: "CLAIM_SUPPORT_QUESTION_DISPUTED",
      questionRelevance: { decision: "INSUFFICIENT" },
    } as never;
    expect(traceS2SemanticPipeline(f)).toMatchObject({
      status: "QUESTION_ROLE_UNPROVEN",
      stageStatuses: { claim: "SUPPORTS", question: "INSUFFICIENT" },
    });
  });
  it("preserves a conflicting role probe as diagnostic, not an authoritative gate", () => {
    const f = fixture();
    f.projection = {
      ...f.projection,
      roleDecision: "MISMATCH",
      status: "ROLE_DISPUTED_CLAIM_CANDIDATE",
    } as never;
    expect(traceS2SemanticPipeline(f)).toMatchObject({
      status: "SHADOW_CANDIDATE_NOT_RELEASE",
      firstUnprovenStage: null,
      stageStatuses: {
        roleProbe: "MISMATCH",
        question: "SUPPORTS",
        claim: "SUPPORTS",
      },
      productionAdmission: false,
    });
  });
  it("does not let a false-positive MATCH plus F3 support rescue an interrogative projection", () => {
    const f = fixture();
    f.projection = {
      ...f.projection,
      claimText: "¿Cuál es el objeto que concede permiso, the access proxy?",
      roleDecision: "MATCH",
      projectedClaimRoleDecision: "MATCH",
      status: "CLAIM_CANDIDATE",
    } as never;
    expect(traceS2SemanticPipeline(f)).toMatchObject({
      status: "PROJECTION_FAILED",
      firstUnprovenStage: "PROJECTION",
      stageStatuses: {
        claim: "SUPPORTS",
        roleProbe: "MATCH",
        projectedRoleProbe: "MATCH",
        projectionSurface: "INTERROGATIVE_SURFACE_REQUIRES_REWRITE",
      },
      productionAdmission: false,
    });
    f.projection = {
      ...f.projection,
      claimText: "Is the access proxy the object that grants permission?",
    } as never;
    expect(traceS2SemanticPipeline(f).firstUnprovenStage).toBe("PROJECTION");
  });

  it("rejects malformed untrusted projection text rather than throwing or trusting source-model support", () => {
    const f = fixture();
    for (const payload of [
      42,
      { arbitrary: true },
      "bad" + String.fromCharCode(0xd800),
    ]) {
      f.projection = { ...f.projection, claimText: payload } as never;
      expect(traceS2SemanticPipeline(f)).toMatchObject({
        status: "PROJECTION_FAILED",
        firstUnprovenStage: "PROJECTION",
        productionAdmission: false,
      });
    }
  });

  it("does not treat claim entailment as proven by question relevance", () => {
    const f = fixture();
    f.claimSemantics = {
      ...f.claimSemantics,
      status: "INSUFFICIENT",
      claimEntailment: { decision: "INSUFFICIENT" },
    } as never;
    expect(traceS2SemanticPipeline(f)).toMatchObject({
      firstUnprovenStage: "CLAIM",
      stageStatuses: { question: "SUPPORTS", claim: "INSUFFICIENT" },
    });
  });
  it("does not allow an optimistic whole-answer status to mask an invalid facet review", () => {
    for (const facet of [
      "SOURCE_OR_REVIEW_BINDING_INVALID",
      "APPLICABILITY_REVIEW_REQUIRED",
      "RELATION_CONFLICT_PROPOSED",
      "APPLICABLE_OBSERVATION_UNCERTAIN",
    ]) {
      const f = fixture();
      f.wholeAnswer = {
        status: "COMPLETE_SUPPORTED_CANDIDATE",
        relationFacetAudit: facet,
      } as never;
      expect(traceS2SemanticPipeline(f)).toMatchObject({
        status: "WHOLE_ANSWER_NOT_VERIFIED",
        firstUnprovenStage: "COMPLETE_ANSWER",
        stageStatuses: { relationFacets: facet },
        productionAdmission: false,
      });
    }
    const valid = fixture();
    valid.wholeAnswer = {
      status: "COMPLETE_SUPPORTED_CANDIDATE",
      relationFacetAudit: "ALL_APPLICABLE_FACETS_ALIGNED_PROPOSAL_ONLY",
    } as never;
    expect(traceS2SemanticPipeline(valid)).toMatchObject({
      status: "SHADOW_CANDIDATE_NOT_RELEASE",
      stageStatuses: {
        relationFacets: "ALL_APPLICABLE_FACETS_ALIGNED_PROPOSAL_ONLY",
      },
      releaseGateAccepted: false,
    });
  });
  it("distinguishes citation reconciliation from the final whole-answer check", () => {
    const f = fixture();
    f.citations = { status: "WITHHELD_UNSUPPORTED_CITATION" } as never;
    expect(traceS2SemanticPipeline(f).firstUnprovenStage).toBe("CITATIONS");
    f.citations = { status: "SOURCE_BOUND_CANDIDATE" } as never;
    f.wholeAnswer = { status: "ABSTENTION_UNVERIFIED" } as never;
    expect(traceS2SemanticPipeline(f).firstUnprovenStage).toBe(
      "COMPLETE_ANSWER",
    );
  });
});
