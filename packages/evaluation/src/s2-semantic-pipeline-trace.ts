import { createHash } from "node:crypto";
import type { NativeWriterObservation } from "./s2-native-structured-writer.js";
import {
  inspectS2ProjectionSurface,
  type S2QuestionClaimCandidate,
} from "./s2-question-answer-claim.js";
import type { S2SemanticEvidenceAssessment } from "./s2-semantic-evidence.js";
import type { S2WriterCitationReconciliation } from "./s2-writer-citation-reconciliation.js";
import type { S2CompleteAnswerAssessment } from "./s2-complete-answer-evidence.js";

/**
 * Evidence-lineage audit, not a release-admission algorithm.
 *
 * Preserve each stage independently so "the LLM failed" cannot conceal
 * provider-schema errors, discarded answers, defective claim projection,
 * unbound citations, overconfident entailment or incomplete final answers.
 * A downstream positive proposal MUST NOT repair a missing upstream proof.
 */
export interface S2SemanticPipelineTraceInput {
  readonly originalQuestion: string;
  readonly writer: NativeWriterObservation | null;
  readonly projection: S2QuestionClaimCandidate | null;
  readonly claimSemantics: S2SemanticEvidenceAssessment | null;
  readonly citations: S2WriterCitationReconciliation | null;
  readonly wholeAnswer: S2CompleteAnswerAssessment | null;
}
export interface S2SemanticPipelineTrace {
  readonly status:
    | "NOT_OBSERVED"
    | "WRITER_CONTRACT_REJECTED"
    | "ABSTENTION_NOT_ADJUDICATED"
    | "PROJECTION_NOT_OBSERVED"
    | "PROJECTION_FAILED"
    | "PROJECTION_INPUT_BINDING_MISMATCH"
    | "ORIGINAL_ATTRIBUTION_UNPROVEN"
    | "QUESTION_ROLE_UNPROVEN"
    | "CLAIM_ENTAILMENT_UNPROVEN"
    | "CITATIONS_NOT_RECONCILED"
    | "WHOLE_ANSWER_NOT_VERIFIED"
    | "SHADOW_CANDIDATE_NOT_RELEASE";
  /** The first stage whose proof is missing. Not proof of root cause. */
  readonly firstUnprovenStage:
    | "WRITER"
    | "PROJECTION"
    | "SOURCE"
    | "QUESTION"
    | "CLAIM"
    | "CITATIONS"
    | "COMPLETE_ANSWER"
    | null;
  readonly stageStatuses: {
    readonly writer: string | null;
    readonly projection: string | null;
    readonly roleProbe: string | null;
    readonly projectedRoleProbe: string | null;
    readonly projectionSurface: string | null;
    readonly source: string | null;
    readonly question: string | null;
    readonly claim: string | null;
    readonly citations: string | null;
    readonly completeAnswer: string | null;
  };
  readonly sourceBoundUtf16Observed: boolean;
  readonly completeAnswerCandidateObserved: boolean;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
export function traceS2SemanticPipeline(
  input: S2SemanticPipelineTraceInput,
): S2SemanticPipelineTrace {
  const w = input.writer;
  const p = input.projection;
  const s = input.claimSemantics;
  const c = input.citations;
  const a = input.wholeAnswer;
  const stageStatuses = {
    writer: w?.status ?? null,
    projection: p?.status ?? null,
    roleProbe: p?.roleDecision ?? null,
    projectedRoleProbe: p?.projectedClaimRoleDecision ?? null,
    projectionSurface: p?.claimText
      ? inspectS2ProjectionSurface(p.claimText)
      : null,
    source: s?.attribution?.status ?? null,
    question: s?.questionRelevance?.decision ?? null,
    claim: s?.claimEntailment?.decision ?? null,
    citations: c?.status ?? null,
    completeAnswer: a?.status ?? null,
  } as const;
  const sourceBoundUtf16Observed =
    s?.attribution?.status === "VERBATIM_UNIQUE_SOURCE_BOUND" &&
    typeof s.attribution.sourceSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(s.attribution.sourceSha256) &&
    Number.isSafeInteger(s.attribution.startUtf16) &&
    Number.isSafeInteger(s.attribution.endUtf16) &&
    s.attribution.startUtf16 !== null &&
    s.attribution.endUtf16 !== null &&
    s.attribution.endUtf16 > s.attribution.startUtf16;
  const completeAnswerCandidateObserved =
    a?.status === "COMPLETE_SUPPORTED_CANDIDATE";
  const make = (
    status: S2SemanticPipelineTrace["status"],
    firstUnprovenStage: S2SemanticPipelineTrace["firstUnprovenStage"],
  ): S2SemanticPipelineTrace => ({
    status,
    firstUnprovenStage,
    stageStatuses,
    sourceBoundUtf16Observed,
    completeAnswerCandidateObserved,
    productionAdmission: false,
    releaseGateAccepted: false,
  });

  if (!w) return make("NOT_OBSERVED", "WRITER");
  if (w.status !== "STRUCTURALLY_VALID")
    return make("WRITER_CONTRACT_REJECTED", "WRITER");
  if (w.abstained === true) return make("ABSTENTION_NOT_ADJUDICATED", "WRITER");
  if (
    w.abstained !== false ||
    !w.answerText?.trim() ||
    w.citations.length === 0
  )
    return make("WRITER_CONTRACT_REJECTED", "WRITER");
  if (!p) return make("PROJECTION_NOT_OBSERVED", "PROJECTION");
  if (
    !p.claimText ||
    !["CLAIM_CANDIDATE", "ROLE_DISPUTED_CLAIM_CANDIDATE"].includes(p.status)
  )
    return make("PROJECTION_FAILED", "PROJECTION");
  if (
    inspectS2ProjectionSurface(p.claimText) !==
    "NO_INTERROGATIVE_MARKER_OBSERVED"
  )
    return make("PROJECTION_FAILED", "PROJECTION");
  // The writer's actual answer, rather than the projector's echo or a
  // caller-chosen paraphrase, must be exactly the frozen projection input.
  const expectedPairSha256 = createHash("sha256")
    .update(input.originalQuestion)
    .update(Buffer.from([0]))
    .update(w.answerText)
    .digest("hex");
  if (
    !input.originalQuestion.trim() ||
    !p.questionAnswerSha256 ||
    p.questionAnswerSha256 !== expectedPairSha256
  )
    return make("PROJECTION_INPUT_BINDING_MISMATCH", "PROJECTION");
  if (!sourceBoundUtf16Observed)
    return make("ORIGINAL_ATTRIBUTION_UNPROVEN", "SOURCE");
  // Role probing is a diagnostic, not a veto. Real multilingual positives
  // revealed false role mismatches; question-focus and full-claim F3 are
  // separately observed. Preserve role disagreement in the returned trace.
  if (s?.questionRelevance?.decision !== "SUPPORTS")
    return make("QUESTION_ROLE_UNPROVEN", "QUESTION");
  if (
    s?.status !== "SUPPORTED_CANDIDATE" ||
    s.claimEntailment?.decision !== "SUPPORTS"
  )
    return make("CLAIM_ENTAILMENT_UNPROVEN", "CLAIM");
  if (c?.status !== "SOURCE_BOUND_CANDIDATE")
    return make("CITATIONS_NOT_RECONCILED", "CITATIONS");
  if (!completeAnswerCandidateObserved)
    return make("WHOLE_ANSWER_NOT_VERIFIED", "COMPLETE_ANSWER");
  // Even an all-positive shadow trace is not a certification of model truth,
  // independent adjudication, HTTP admission or release readiness.
  return make("SHADOW_CANDIDATE_NOT_RELEASE", null);
}
