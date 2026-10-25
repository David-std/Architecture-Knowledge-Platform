import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  traceS2EndToEndEvidence,
  type S2EndToEndTraceInput,
} from "../src/s2-end-to-end-evidence-trace.js";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const question = "Which proxy grants permission?";
const answer = "the access proxy";
function fixture(): Mutable<S2EndToEndTraceInput> {
  const bodySha = sha("source"),
    requestSha = sha("frozen provider bytes");
  return {
    language: "en",
    originalQuestion: question,
    http: {
      status: "HTTP_ADMITTED_WRITER_READY",
      returnedRetrievalOutcome: "SUPPORTED",
      admittedHitCount: 1,
      selectedSourceCount: 1,
      bridge: {
        status: "RETRIEVAL_BOUND_WRITER_READY",
        selectedEvidence: [
          {
            passageId: "SRC1",
            sourceSha256: bodySha,
            bodyStartUtf16: 5,
            bodyEndUtf16: 23,
          },
        ],
        exactProviderRequest: {
          freeze: {
            caseKeySha256: sha("en\0" + question),
            exactRequestSha256: requestSha,
            sourcePassages: [
              {
                id: "SRC1",
                source: "ORIGINAL_LITERAL_MATCH",
                original: { fileSha256: bodySha, startUtf16: 5, endUtf16: 23 },
              },
            ],
          },
        },
      },
    } as never,
    httpOriginalReplay: null,
    writer: {
      status: "STRUCTURALLY_VALID",
      gateAccepted: false,
      abstained: false,
      answerText: answer,
      citations: ["SRC1"],
      requestSha256: requestSha,
    } as never,
    projection: {
      status: "CLAIM_CANDIDATE",
      claimText: "The access proxy grants permission.",
      questionAnswerSha256: sha(question + "\0" + answer),
      roleDecision: "MATCH",
    } as never,
    claimSemantics: {
      status: "SUPPORTED_CANDIDATE",
      attribution: {
        status: "VERBATIM_UNIQUE_SOURCE_BOUND",
        sourceSha256: bodySha,
        startUtf16: 5,
        endUtf16: 23,
      },
      questionRelevance: { decision: "SUPPORTS" },
      claimEntailment: { decision: "SUPPORTS" },
    } as never,
    citations: { status: "SOURCE_BOUND_CANDIDATE" } as never,
    wholeAnswer: { status: "COMPLETE_SUPPORTED_CANDIDATE" } as never,
  };
}
describe("S2 full HTTP→writer→source→semantic shadow provenance", () => {
  it("never turns a completely supported trace into production authority", () => {
    expect(traceS2EndToEndEvidence(fixture())).toMatchObject({
      status: "SEMANTIC_DOWNSTREAM_SHADOW_CANDIDATE",
      firstUnprovenStage: null,
      selectedSourceCount: 1,
      writerRequestSourceBound: true,
      optionalHttpOriginalQuoteReplay: "NOT_CAPTURED",
      productionAdmission: false,
      releaseGateAccepted: false,
      authorizationIndependentlyVerified: false,
    });
  });
  it("does not pretend missing HTTP is an authenticated request", () => {
    const f = fixture();
    f.http = null;
    expect(traceS2EndToEndEvidence(f)).toMatchObject({
      status: "HTTP_CAPTURE_MISSING",
      firstUnprovenStage: "AUTHORIZATION",
    });
  });
  it("never feeds an exploratory-only source into the writer", () => {
    const f = fixture();
    f.http = {
      ...f.http,
      status: "HTTP_NO_ADMITTED_EVIDENCE",
      returnedRetrievalOutcome: "EXPLORATORY_ONLY",
    } as never;
    expect(traceS2EndToEndEvidence(f)).toMatchObject({
      status: "HTTP_SCOPE_OR_RETRIEVAL_WITHHELD",
      firstUnprovenStage: "RETRIEVAL",
    });
  });
  it("catches exact original passage mismatch even if source hash is plausible", () => {
    const f = fixture();
    f.http = {
      ...f.http,
      bridge: {
        ...(f.http as any).bridge,
        selectedEvidence: [
          { ...(f.http as any).bridge.selectedEvidence[0], bodyEndUtf16: 24 },
        ],
      },
    } as never;
    expect(traceS2EndToEndEvidence(f).firstUnprovenStage).toBe(
      "EVIDENCE_SELECTION",
    );
  });
  it("does not accept a source passage with no exact-original proof", () => {
    const f = fixture();
    const h = f.http as any;
    f.http = {
      ...h,
      bridge: {
        ...h.bridge,
        exactProviderRequest: {
          freeze: {
            ...h.bridge.exactProviderRequest.freeze,
            sourcePassages: [
              {
                ...h.bridge.exactProviderRequest.freeze.sourcePassages[0],
                source: "UNBOUND_PROJECTION",
              },
            ],
          },
        },
      },
    } as never;
    expect(traceS2EndToEndEvidence(f).status).toBe(
      "HTTP_WRITER_SOURCE_UNBOUND",
    );
  });
  it("detects a replayed provider request for the wrong question", () => {
    const f = fixture();
    f.originalQuestion = "What changes permission?";
    expect(traceS2EndToEndEvidence(f)).toMatchObject({
      status: "HTTP_QUESTION_IDENTITY_MISMATCH",
      firstUnprovenStage: "WRITER",
    });
  });
  it("detects a different or missing frozen writer request", () => {
    const f = fixture();
    f.writer = {
      ...f.writer,
      requestSha256: sha("not the actual request"),
    } as never;
    expect(traceS2EndToEndEvidence(f).status).toBe("PROVIDER_REQUEST_MISMATCH");
  });
  it("rejects a source ID that was not in the admitted provider request", () => {
    const f = fixture();
    f.writer = { ...f.writer, citations: ["SRC2"] } as never;
    expect(traceS2EndToEndEvidence(f)).toMatchObject({
      status: "WRITER_REFERENCES_NONADMITTED_SOURCE",
      firstUnprovenStage: "SOURCE",
    });
  });
  it("fails closed when an optional original HTTP quote replay explicitly fails", () => {
    const f = fixture();
    f.httpOriginalReplay = {
      status: "REJECTED",
      reason: "QUOTE_NOT_ORIGINAL",
    } as never;
    expect(traceS2EndToEndEvidence(f)).toMatchObject({
      status: "HTTP_ORIGINAL_REPLAY_REJECTED",
      firstUnprovenStage: "EVIDENCE_SELECTION",
      optionalHttpOriginalQuoteReplay: "REJECTED",
      productionAdmission: false,
    });
  });
  it("exposes applicable-relation disagreement after HTTP binding without turning it into release admission", () => {
    const f = fixture();
    f.httpOriginalReplay = { status: "REPLAY_VERIFIED" } as never;
    f.wholeAnswer = {
      status: "INSUFFICIENT",
      relationFacetAudit: "RELATION_CONFLICT_PROPOSED",
      relationFacetIndependentAdjudicationVerified: false,
      productionAdmission: false,
    } as never;
    expect(traceS2EndToEndEvidence(f)).toMatchObject({
      status: "SEMANTIC_DOWNSTREAM_UNPROVEN",
      firstUnprovenStage: "COMPLETE_ANSWER",
      optionalHttpOriginalQuoteReplay: "REPLAY_VERIFIED",
      downstream: {
        status: "WHOLE_ANSWER_NOT_VERIFIED",
        stageStatuses: { relationFacets: "RELATION_CONFLICT_PROPOSED" },
        productionAdmission: false,
      },
      releaseGateAccepted: false,
    });
  });
  it("preserves a downstream claim dispute and independent replay diagnostics", () => {
    const f = fixture();
    f.claimSemantics = {
      ...f.claimSemantics,
      status: "CLAIM_SUPPORT_QUESTION_DISPUTED",
      questionRelevance: { decision: "INSUFFICIENT" },
    } as never;
    f.httpOriginalReplay = { status: "REPLAY_VERIFIED" } as never;
    expect(traceS2EndToEndEvidence(f)).toMatchObject({
      status: "SEMANTIC_DOWNSTREAM_UNPROVEN",
      firstUnprovenStage: "QUESTION",
      optionalHttpOriginalQuoteReplay: "REPLAY_VERIFIED",
      downstream: {
        status: "QUESTION_ROLE_UNPROVEN",
        stageStatuses: { claim: "SUPPORTS" },
      },
    });
  });
});
