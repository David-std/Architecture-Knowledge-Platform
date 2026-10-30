import { createHash } from "node:crypto";
import {
  attributeS2VerbatimQuote,
  type S2ExactQuoteOriginal,
} from "./s2-exact-quote-attribution.js";
import {
  buildS2PairedQuoteEvidenceTokenFormat,
  freezeS2QuoteEvidenceOptions,
  resolveS2QuoteEvidenceToken,
  type S2FrozenQuoteEvidenceOptions,
} from "./s2-quote-evidence-choice.js";
import {
  assessS2QuoteSemantics,
  type S2SemanticEvidenceAssessment,
  type S2SemanticEvidenceConfig,
} from "./s2-semantic-evidence.js";

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * S2 evaluation-only adapter. SOURCE provenance and quote IDs are frozen
 * before model inference; the model's decision is a *proposal*, never admission.
 * The already-existing F3 binding and question/claim probes are reused.
 */
export interface S2FrozenReaderChoiceInput {
  readonly originalQuestion: string;
  readonly proposedClaim: string;
  readonly exactSourceQuote: string;
  /** Authorized and revision-pinned by the caller, NOT by this adapter. */
  readonly authorizedOriginal: S2ExactQuoteOriginal;
}

export interface S2FrozenReaderChoicePlan {
  readonly schemaVersion: "akp.s2.frozen-reader-source-bridge.v1";
  readonly originalQuestionSha256: string;
  readonly proposedClaimSha256: string;
  readonly quoteSha256: string;
  readonly assignedSourceId: string;
  readonly sourceSha256: string;
  readonly sourceStartUtf16: number;
  readonly sourceEndUtf16: number;
  readonly frozen: S2FrozenQuoteEvidenceOptions;
  readonly tokenSchema: ReturnType<
    typeof buildS2PairedQuoteEvidenceTokenFormat
  >;
  readonly sourceAuthorizationIndependentlyVerified: false;
  readonly semanticRelationIndependentlyVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

export interface S2FrozenReaderChoiceResult {
  readonly status: "HELD" | "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY";
  readonly reason: string;
  readonly originalQuoteStartUtf16: number | null;
  readonly originalQuoteEndUtf16: number | null;
  readonly assessment: S2SemanticEvidenceAssessment | null;
  readonly sourceAuthorizationIndependentlyVerified: false;
  readonly semanticRelationIndependentlyVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

const held = (reason: string): S2FrozenReaderChoiceResult => ({
  status: "HELD",
  reason,
  originalQuoteStartUtf16: null,
  originalQuoteEndUtf16: null,
  assessment: null,
  sourceAuthorizationIndependentlyVerified: false,
  semanticRelationIndependentlyVerified: false,
  productionAdmission: false,
  releaseGateAccepted: false,
});

export function freezeS2FrozenReaderChoicePlan(
  input: S2FrozenReaderChoiceInput,
  maxChunkUtf16 = 1400,
): S2FrozenReaderChoicePlan {
  if (
    !input.originalQuestion.trim() ||
    input.originalQuestion.length > 2048 ||
    !input.proposedClaim.trim() ||
    input.proposedClaim.length > 4096
  ) {
    throw new Error("S2_FROZEN_READER_QUESTION_OR_CLAIM_INVALID");
  }
  const { authorizedOriginal: original, exactSourceQuote: quote } = input;
  const attribution = attributeS2VerbatimQuote(
    {
      answerText: input.proposedClaim,
      evidenceQuote: quote,
      sourceId: original.assignedSourceId,
      abstained: false,
    },
    [original],
  );
  if (
    attribution.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
    attribution.assignedSourceId !== original.assignedSourceId ||
    attribution.sourceSha256 !== original.sourceSha256 ||
    attribution.startUtf16 === null ||
    attribution.endUtf16 === null
  ) {
    throw new Error("S2_FROZEN_READER_ORIGINAL_SOURCE_NOT_BOUND");
  }
  const frozen = freezeS2QuoteEvidenceOptions(quote, maxChunkUtf16);
  return {
    schemaVersion: "akp.s2.frozen-reader-source-bridge.v1",
    originalQuestionSha256: hash(input.originalQuestion),
    proposedClaimSha256: hash(input.proposedClaim),
    quoteSha256: hash(quote),
    assignedSourceId: original.assignedSourceId,
    sourceSha256: original.sourceSha256,
    sourceStartUtf16: attribution.startUtf16,
    sourceEndUtf16: attribution.endUtf16,
    frozen,
    tokenSchema: buildS2PairedQuoteEvidenceTokenFormat(quote, frozen),
    sourceAuthorizationIndependentlyVerified: false,
    semanticRelationIndependentlyVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}

/** A legal token can only select original bytes. It cannot certify entailment. */
export async function assessS2FrozenReaderChoice(
  input: S2FrozenReaderChoiceInput,
  plan: S2FrozenReaderChoicePlan,
  proposal: unknown,
  probes: S2SemanticEvidenceConfig,
): Promise<S2FrozenReaderChoiceResult> {
  let replay: S2FrozenReaderChoicePlan;
  try {
    replay = freezeS2FrozenReaderChoicePlan(input, plan.frozen.maxChunkUtf16);
  } catch {
    return held("SOURCE_OR_PLAN_REPLAY_FAILED");
  }
  if (JSON.stringify(plan) !== JSON.stringify(replay)) {
    return held("SOURCE_QUESTION_CLAIM_OR_FROZEN_PLAN_DRIFT");
  }
  if (
    !proposal ||
    typeof proposal !== "object" ||
    Array.isArray(proposal) ||
    Object.keys(proposal).sort().join(",") !== "claimToken,questionToken"
  ) {
    return held("MODEL_TOKEN_OUTPUT_INVALID");
  }
  const output = proposal as Record<string, unknown>;
  const question = resolveS2QuoteEvidenceToken(
    input.exactSourceQuote,
    plan.frozen,
    output.questionToken,
  );
  const claim = resolveS2QuoteEvidenceToken(
    input.exactSourceQuote,
    plan.frozen,
    output.claimToken,
  );
  if (
    question.reason === "MODEL_LITERAL_EVIDENCE_CHOICE_INVALID" ||
    claim.reason === "MODEL_LITERAL_EVIDENCE_CHOICE_INVALID"
  ) {
    return held("MODEL_FROZEN_ID_INVALID");
  }
  if (question.decision !== "SUPPORTS" || claim.decision !== "SUPPORTS") {
    return held("QUESTION_OR_CLAIM_NOT_SUPPORTED_BY_MODEL_PROPOSAL");
  }
  if (
    !question.evidenceSpan ||
    !claim.evidenceSpan ||
    question.evidenceSpan.startUtf16 !== claim.evidenceSpan.startUtf16 ||
    question.evidenceSpan.endUtf16 !== claim.evidenceSpan.endUtf16
  ) {
    return held("QUESTION_AND_CLAIM_SELECTED_DIFFERENT_SPANS");
  }
  const selected = input.exactSourceQuote.slice(
    question.evidenceSpan.startUtf16,
    question.evidenceSpan.endUtf16,
  );
  // Prove the exact selected subquote again against the authenticated original.
  // F3 rejects a repeated quote, edited text, heading-only text and malformed
  // UTF-16 boundaries rather than repairing it.
  const assessment = await assessS2QuoteSemantics(
    input.originalQuestion,
    {
      answerText: input.proposedClaim,
      evidenceQuote: selected,
      sourceId: plan.assignedSourceId,
      abstained: false,
    },
    [input.authorizedOriginal],
    probes,
  );
  if (assessment.status !== "SUPPORTED_CANDIDATE") {
    return {
      ...held("SEMANTIC_OR_F3_PROOF_NOT_ESTABLISHED"),
      assessment,
    };
  }
  return {
    status: "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY",
    reason: "FROZEN_ORIGINAL_QUOTE_AND_TWO_PROBES_PROPOSE_SUPPORT",
    originalQuoteStartUtf16: assessment.attribution.startUtf16,
    originalQuoteEndUtf16: assessment.attribution.endUtf16,
    assessment,
    sourceAuthorizationIndependentlyVerified: false,
    semanticRelationIndependentlyVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}
