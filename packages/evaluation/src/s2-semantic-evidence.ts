import { explicitClaimNumbersBoundToQuote } from "./s2-claim-numeric-integrity.js";
import {
  attributeS2VerbatimQuote,
  type S2ExactQuoteAttribution,
  type S2ExactQuoteModelOutput,
  type S2ExactQuoteOriginal,
} from "./s2-exact-quote-attribution.js";

export type S2SemanticVerdict = "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT";

export interface S2SemanticProbeResult {
  readonly decision: S2SemanticVerdict;
  readonly reason: string;
  readonly score?: number;
  /** UTF-16 offsets relative to the exact, source-bound evidence quote. */
  readonly evidenceSpan?: {
    readonly startUtf16: number;
    readonly endUtf16: number;
  };
}

export interface S2SemanticProbeInput {
  readonly originalQuestion: string;
  readonly answerClaim: string;
  readonly exactQuote: string;
  /** Context is diagnostic only; a probe must ground its decision in exactQuote. */
  readonly originalBodyContext: string;
  readonly verifiedSourceId: string;
  readonly verifiedSourceSha256: string;
  readonly quoteStartUtf16: number;
  readonly quoteEndUtf16: number;
}

export interface S2SemanticProbe {
  /** A revision-pinned identifier for the implementation/model and thresholds. */
  readonly id: string;
  verify(input: S2SemanticProbeInput): Promise<S2SemanticProbeResult>;
}

export interface S2SemanticEvidenceConfig {
  readonly questionRelevanceProbe: S2SemanticProbe;
  readonly claimEntailmentProbe: S2SemanticProbe;
  readonly timeoutMs?: number;
  readonly maxBodyContextUtf16?: number;
  /**
   * Shadow-only independent claim observation after an uncertain relevance
   * verdict. This is NOT an instruction to admit a question-disputed answer:
   * a claim-level support proposal still needs question/answer-slot proof.
   * Default false preserves the historically conservative cascade.
   */
  readonly inspectClaimWhenQuestionUncertain?: boolean;
}

export interface S2SemanticEvidenceAssessment {
  readonly status:
    | "SUPPORTED_CANDIDATE"
    | "CLAIM_SUPPORT_QUESTION_DISPUTED"
    | "CLAIM_CONTRADICTION_QUESTION_DISPUTED"
    | "CONTRADICTED"
    | "INSUFFICIENT"
    | "ERROR"
    | "VALID_ABSTAIN"
    | "REJECTED";
  readonly reason: string;
  readonly attribution: S2ExactQuoteAttribution;
  readonly questionRelevance: S2SemanticProbeResult | null;
  readonly claimEntailment: S2SemanticProbeResult | null;
  readonly questionProbeId: string | null;
  readonly claimProbeId: string | null;
  /** No experimental model can approve an S2 production release. */
  readonly releaseGateAccepted: false;
  readonly productionAdmission: false;
}

type Stage = "QUESTION" | "CLAIM";

const positiveInteger = (value: number, max: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= max;

const validBoundary = (value: string, index: number): boolean =>
  Number.isSafeInteger(index) &&
  index >= 0 &&
  index <= value.length &&
  !(
    index > 0 &&
    index < value.length &&
    value.charCodeAt(index - 1) >= 0xd800 &&
    value.charCodeAt(index - 1) <= 0xdbff &&
    value.charCodeAt(index) >= 0xdc00 &&
    value.charCodeAt(index) <= 0xdfff
  );

function validProbeResult(
  value: S2SemanticProbeResult,
  quote: string,
): value is S2SemanticProbeResult {
  if (
    !value ||
    !["SUPPORTS", "CONTRADICTS", "INSUFFICIENT"].includes(value.decision) ||
    typeof value.reason !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,99}$/u.test(value.reason) ||
    (value.score !== undefined &&
      (!Number.isFinite(value.score) || value.score < 0 || value.score > 1))
  )
    return false;
  if (value.decision === "INSUFFICIENT") return true;
  const span = value.evidenceSpan;
  return (
    span !== undefined &&
    validBoundary(quote, span.startUtf16) &&
    validBoundary(quote, span.endUtf16) &&
    span.startUtf16 < span.endUtf16
  );
}

async function runProbe(
  probe: S2SemanticProbe,
  input: S2SemanticProbeInput,
  timeoutMs: number,
): Promise<{ result: S2SemanticProbeResult | null; error: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => probe.verify(input)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
      }),
    ]);
    if (!validProbeResult(result, input.exactQuote)) {
      return { result: null, error: true };
    }
    return { result, error: false };
  } catch {
    // Never put exception messages (potential source text) in public diagnostics.
    return { result: null, error: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Experimental quote-then-semantics cascade. F proves bytes/source/span;
 * QA-like relevance and NLI-like claim entailment are distinct, pinned ports.
 * Their joint SUPPORTS is only an evaluation candidate, NEVER admission.
 *
 * Neither a hallucinated SRCn nor an exploratory hit authorizes a source:
 * all originals must already have been authorized and SHA-pinned by caller.
 */
export async function assessS2QuoteSemantics(
  originalQuestion: string,
  output: S2ExactQuoteModelOutput,
  authorizedOriginals: readonly S2ExactQuoteOriginal[],
  config: S2SemanticEvidenceConfig,
): Promise<S2SemanticEvidenceAssessment> {
  const attribution = attributeS2VerbatimQuote(output, authorizedOriginals);
  const make = (
    status: S2SemanticEvidenceAssessment["status"],
    reason: string,
    questionRelevance: S2SemanticProbeResult | null = null,
    claimEntailment: S2SemanticProbeResult | null = null,
  ): S2SemanticEvidenceAssessment => ({
    status,
    reason,
    attribution,
    questionRelevance,
    claimEntailment,
    questionProbeId: config.questionRelevanceProbe?.id ?? null,
    claimProbeId: config.claimEntailmentProbe?.id ?? null,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (attribution.status === "REJECTED")
    return make("REJECTED", attribution.reason);
  if (attribution.status === "VALID_ABSTAIN")
    return make("VALID_ABSTAIN", "MODEL_ABSTAINED");
  if (
    typeof originalQuestion !== "string" ||
    !originalQuestion.trim() ||
    originalQuestion.length > 2048 ||
    output.answerText.length > 4096 ||
    !config.questionRelevanceProbe?.id?.includes("@") ||
    !config.claimEntailmentProbe?.id?.includes("@") ||
    config.questionRelevanceProbe === config.claimEntailmentProbe ||
    config.questionRelevanceProbe.id === config.claimEntailmentProbe.id ||
    (config.inspectClaimWhenQuestionUncertain !== undefined &&
      typeof config.inspectClaimWhenQuestionUncertain !== "boolean")
  )
    return make("REJECTED", "SEMANTIC_INPUT_OR_PROBE_INVALID");

  const timeoutMs = config.timeoutMs ?? 60_000;
  const maxBody = config.maxBodyContextUtf16 ?? 16_000;
  if (
    !positiveInteger(timeoutMs, 600_000) ||
    !positiveInteger(maxBody, 100_000)
  )
    return make("REJECTED", "SEMANTIC_BUDGET_INVALID");

  const source = authorizedOriginals.find(
    (entry) => entry.assignedSourceId === attribution.assignedSourceId,
  );
  if (
    !source ||
    attribution.startUtf16 === null ||
    attribution.endUtf16 === null ||
    attribution.sourceSha256 !== source.sourceSha256
  )
    return make("REJECTED", "QUOTE_SOURCE_BINDING_MISSING");
  // F has already checked fatal UTF-8 decoding, SHA, and body boundaries.
  const decoded = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(source.exactUtf8Bytes);
  const context = decoded.slice(source.bodyStartUtf16, source.bodyEndUtf16);
  if (context.length > maxBody)
    return make("INSUFFICIENT", "ORIGINAL_CONTEXT_EXCEEDS_BUDGET");
  if (
    decoded.slice(attribution.startUtf16, attribution.endUtf16) !==
    output.evidenceQuote
  )
    return make("REJECTED", "QUOTE_REPLAY_MISMATCH");
  const input: S2SemanticProbeInput = {
    originalQuestion,
    answerClaim: output.answerText,
    exactQuote: output.evidenceQuote,
    originalBodyContext: context,
    verifiedSourceId: source.assignedSourceId,
    verifiedSourceSha256: source.sourceSha256,
    quoteStartUtf16: attribution.startUtf16,
    quoteEndUtf16: attribution.endUtf16,
  };
  const integrity = explicitClaimNumbersBoundToQuote(
    input.exactQuote,
    input.answerClaim,
  );
  if (!integrity.eligible) return make("INSUFFICIENT", integrity.reason);
  const question = await runProbe(
    config.questionRelevanceProbe,
    input,
    timeoutMs,
  );
  if (question.error) return make("ERROR", "QUESTION_PROBE_ERROR");
  const relevance = question.result!;
  if (
    relevance.decision !== "SUPPORTS" &&
    config.inspectClaimWhenQuestionUncertain !== true
  )
    // An interrogative question cannot logically be contradicted by a quote.
    // A reader's CONTRADICTS verdict at the relevance stage is merely an
    // unsuccessful attempt to locate the requested answer. Preserve the raw
    // probe verdict for diagnostics, without manufacturing source conflict.
    return make(
      "INSUFFICIENT",
      relevance.decision === "CONTRADICTS"
        ? "QUESTION_RELEVANCE_CONTRADICTION_NOT_PROOF"
        : "QUESTION_RELEVANCE_INSUFFICIENT",
      relevance,
    );

  const claim = await runProbe(config.claimEntailmentProbe, input, timeoutMs);
  if (claim.error) return make("ERROR", "CLAIM_PROBE_ERROR", relevance);
  const entailment = claim.result!;
  if (relevance.decision !== "SUPPORTS") {
    // A broken question-focus model previously suppressed a claim-level
    // observation altogether. This optional trace recovers that information
    // without treating direct entailment as an answer to the user's question.
    if (entailment.decision === "SUPPORTS")
      return make(
        "CLAIM_SUPPORT_QUESTION_DISPUTED",
        "CLAIM_SUPPORT_PROPOSED_BUT_ANSWER_ROLE_UNVERIFIED",
        relevance,
        entailment,
      );
    if (entailment.decision === "CONTRADICTS")
      return make(
        "CLAIM_CONTRADICTION_QUESTION_DISPUTED",
        "CLAIM_CONTRADICTION_PROPOSED_QUESTION_UNVERIFIED",
        relevance,
        entailment,
      );
    return make(
      "INSUFFICIENT",
      "QUESTION_AND_CLAIM_PROBES_INSUFFICIENT",
      relevance,
      entailment,
    );
  }
  if (entailment.decision !== "SUPPORTS")
    return make(
      entailment.decision === "CONTRADICTS" ? "CONTRADICTED" : "INSUFFICIENT",
      "CLAIM_ENTAILMENT_" + entailment.decision,
      relevance,
      entailment,
    );
  return make(
    "SUPPORTED_CANDIDATE",
    "TWO_STAGE_SEMANTIC_SUPPORT_CANDIDATE",
    relevance,
    entailment,
  );
}
