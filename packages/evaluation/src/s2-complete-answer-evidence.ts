import {
  assessS2QuoteSemantics,
  type S2SemanticEvidenceConfig,
  type S2SemanticEvidenceAssessment,
} from "./s2-semantic-evidence.js";
import type {
  S2ExactQuoteOriginal,
  S2ExactQuoteModelOutput,
} from "./s2-exact-quote-attribution.js";

/**
 * Writer-provided sentence/claim boundaries, never treated as trusted just
 * because they are parseable. Exact UTF-16 coverage prevents omission of a
 * trailing ungrounded sentence, while a separate verifier must validate
 * atomicity and cross-claim consistency.
 */
export interface S2AtomicAnswerClaim {
  readonly claimText: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly evidenceQuote: string;
  readonly claimedSourceId: string;
}

export interface S2CompleteAnswerInput {
  readonly originalQuestion: string;
  readonly answerText: string;
  readonly claims: readonly S2AtomicAnswerClaim[];
  readonly abstained: boolean;
}

export interface S2WholeAnswerCheckInput {
  readonly originalQuestion: string;
  readonly answerText: string;
  readonly claims: readonly S2AtomicAnswerClaim[];
  readonly boundAttributions: readonly {
    readonly sourceId: string;
    readonly sourceSha256: string;
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly exactQuote: string;
    readonly localSourceContext: string;
  }[];
}

export interface S2WholeAnswerCheck {
  readonly id: string;
  verify(
    input: S2WholeAnswerCheckInput,
  ): Promise<"SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT">;
}

export interface S2CompleteAnswerConfig {
  readonly semantic: S2SemanticEvidenceConfig;
  /** Separate whole-answer coverage/atomicity, not a second call to the claim model. */
  readonly atomicityVerifier: S2WholeAnswerCheck;
  /** Checks whether conditions/negations near the quote qualify its meaning. */
  readonly sourceContextVerifier: S2WholeAnswerCheck;
  /** Distinct check for conflicts between claims across multiple sources. */
  readonly consistencyVerifier: S2WholeAnswerCheck;
  readonly maxClaims?: number;
}

export interface S2CompleteAnswerAssessment {
  readonly status:
    | "COMPLETE_SUPPORTED_CANDIDATE"
    | "CONTRADICTED"
    | "INSUFFICIENT"
    | "ERROR"
    | "REJECTED"
    | "ABSTENTION_UNVERIFIED";
  readonly reason: string;
  readonly claimResults: readonly S2SemanticEvidenceAssessment[];
  readonly atomicityCheck: "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT" | null;
  readonly consistencyCheck: "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT" | null;
  readonly sourceContextCheck:
    "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT" | null;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

function boundary(text: string, i: number): boolean {
  if (!Number.isSafeInteger(i) || i < 0 || i > text.length) return false;
  if (i === 0 || i === text.length) return true;
  return !(
    text.charCodeAt(i - 1) >= 0xd800 &&
    text.charCodeAt(i - 1) <= 0xdbff &&
    text.charCodeAt(i) >= 0xdc00 &&
    text.charCodeAt(i) <= 0xdfff
  );
}

function fullyCovered(
  input: S2CompleteAnswerInput,
  maxClaims: number,
): boolean {
  if (
    !input.answerText.trim() ||
    input.answerText.length > 12_000 ||
    !Number.isSafeInteger(maxClaims) ||
    maxClaims < 1 ||
    maxClaims > 32 ||
    input.claims.length < 1 ||
    input.claims.length > maxClaims
  )
    return false;
  let consumed = 0;
  for (const claim of input.claims) {
    if (
      !boundary(input.answerText, claim.startUtf16) ||
      !boundary(input.answerText, claim.endUtf16) ||
      claim.startUtf16 < consumed ||
      claim.endUtf16 <= claim.startUtf16 ||
      input.answerText.slice(claim.startUtf16, claim.endUtf16) !==
        claim.claimText ||
      !claim.claimText.trim() ||
      claim.claimText.length > 2048 ||
      input.answerText.slice(consumed, claim.startUtf16).trim() !== ""
    )
      return false;
    consumed = claim.endUtf16;
  }
  return input.answerText.slice(consumed).trim() === "";
}

/**
 * Evaluate each source-bound clause, then explicitly verify that the set
 * contains no omitted atomic facts or mutually inconsistent propositions.
 * No positive finding from either level is a production admission.
 */
export async function assessS2CompleteAnswer(
  input: S2CompleteAnswerInput,
  originals: readonly S2ExactQuoteOriginal[],
  config: S2CompleteAnswerConfig,
): Promise<S2CompleteAnswerAssessment> {
  const results: S2SemanticEvidenceAssessment[] = [];
  const make = (
    status: S2CompleteAnswerAssessment["status"],
    reason: string,
    atomicityCheck: S2CompleteAnswerAssessment["atomicityCheck"] = null,
    consistencyCheck: S2CompleteAnswerAssessment["consistencyCheck"] = null,
    sourceContextCheck: S2CompleteAnswerAssessment["sourceContextCheck"] = null,
  ): S2CompleteAnswerAssessment => ({
    status,
    reason,
    claimResults: results,
    atomicityCheck,
    consistencyCheck,
    sourceContextCheck,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  // A syntactically empty response cannot establish that the question
  // really had no answer in authorized evidence. Never score it as a
  // justified abstention without a separate source-answerability review.
  if (
    input.abstained === true &&
    input.answerText === "" &&
    Array.isArray(input.claims) &&
    input.claims.length === 0 &&
    typeof input.originalQuestion === "string" &&
    input.originalQuestion.trim() !== "" &&
    input.originalQuestion.length <= 2048
  )
    return make("ABSTENTION_UNVERIFIED", "EMPTY_ABSTENTION_NOT_ADJUDICATED");
  if (
    input.abstained !== false ||
    typeof input.originalQuestion !== "string" ||
    !input.originalQuestion.trim() ||
    !Array.isArray(input.claims) ||
    !fullyCovered(input, config.maxClaims ?? 12) ||
    !config.atomicityVerifier?.id?.trim() ||
    !config.consistencyVerifier?.id?.trim() ||
    !config.sourceContextVerifier?.id?.trim() ||
    config.atomicityVerifier === config.consistencyVerifier ||
    config.sourceContextVerifier === config.consistencyVerifier ||
    config.sourceContextVerifier === config.atomicityVerifier ||
    config.atomicityVerifier.id === config.consistencyVerifier.id ||
    config.sourceContextVerifier.id === config.consistencyVerifier.id ||
    config.sourceContextVerifier.id === config.atomicityVerifier.id ||
    [
      config.atomicityVerifier.id,
      config.consistencyVerifier.id,
      config.sourceContextVerifier.id,
    ].some((id) => !id.includes("@"))
  )
    return make("REJECTED", "CLAIM_COVERAGE_OR_CHECK_CONFIGURATION_INVALID");

  for (const claim of input.claims) {
    const output: S2ExactQuoteModelOutput = {
      answerText: claim.claimText,
      evidenceQuote: claim.evidenceQuote,
      sourceId: claim.claimedSourceId,
      abstained: false,
    };
    const assessed = await assessS2QuoteSemantics(
      input.originalQuestion,
      output,
      originals,
      config.semantic,
    );
    results.push(assessed);
    if (assessed.status !== "SUPPORTED_CANDIDATE") {
      const status =
        assessed.status === "CONTRADICTED"
          ? "CONTRADICTED"
          : assessed.status === "ERROR"
            ? "ERROR"
            : assessed.status === "REJECTED"
              ? "REJECTED"
              : "INSUFFICIENT";
      return make(status, "INDIVIDUAL_CLAIM_" + assessed.status);
    }
  }

  const boundAttributions = results.map((result, i) => {
    const bound = result.attribution;
    const source = originals.find(
      (entry) =>
        entry.assignedSourceId === bound.assignedSourceId &&
        entry.sourceSha256 === bound.sourceSha256,
    )!;
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(source.exactUtf8Bytes);
    const start = bound.startUtf16!;
    const end = bound.endUtf16!;
    const windowStart = Math.max(source.bodyStartUtf16, start - 512);
    const windowEnd = Math.min(source.bodyEndUtf16, end + 512);
    return {
      sourceId: source.assignedSourceId,
      sourceSha256: source.sourceSha256,
      startUtf16: start,
      endUtf16: end,
      exactQuote: input.claims[i]!.evidenceQuote,
      localSourceContext: decoded.slice(windowStart, windowEnd),
    };
  });
  const wholeInput: S2WholeAnswerCheckInput = {
    originalQuestion: input.originalQuestion,
    answerText: input.answerText,
    claims: input.claims,
    boundAttributions,
  };

  const invoke = async (check: S2WholeAnswerCheck) => {
    const ms = config.semantic.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 600_000) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verdict = await Promise.race([
        Promise.resolve().then(() => check.verify(wholeInput)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
        }),
      ]);
      return verdict === "SUPPORTS" ||
        verdict === "CONTRADICTS" ||
        verdict === "INSUFFICIENT"
        ? verdict
        : null;
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  // Adjacent verified source text can qualify, narrow or negate a quoted fact.
  const contextCheck = await invoke(config.sourceContextVerifier);
  if (!contextCheck) return make("ERROR", "SOURCE_CONTEXT_VERIFIER_ERROR");
  if (contextCheck !== "SUPPORTS")
    return make(
      contextCheck === "CONTRADICTS" ? "CONTRADICTED" : "INSUFFICIENT",
      "SOURCE_CONTEXT_" + contextCheck,
      null,
      null,
      contextCheck,
    );
  const atomicity = await invoke(config.atomicityVerifier);
  if (!atomicity)
    return make("ERROR", "ATOMICITY_VERIFIER_ERROR", null, null, contextCheck);
  if (atomicity !== "SUPPORTS")
    return make(
      atomicity === "CONTRADICTS" ? "CONTRADICTED" : "INSUFFICIENT",
      "ATOMICITY_" + atomicity,
      atomicity,
      null,
      contextCheck,
    );
  const consistency = await invoke(config.consistencyVerifier);
  if (!consistency)
    return make(
      "ERROR",
      "CONSISTENCY_VERIFIER_ERROR",
      atomicity,
      null,
      contextCheck,
    );
  if (consistency !== "SUPPORTS")
    return make(
      consistency === "CONTRADICTS" ? "CONTRADICTED" : "INSUFFICIENT",
      "CROSS_CLAIM_" + consistency,
      atomicity,
      consistency,
      contextCheck,
    );
  return make(
    "COMPLETE_SUPPORTED_CANDIDATE",
    "ALL_CLAIMS_BOUND_AND_CHECKED",
    atomicity,
    consistency,
    contextCheck,
  );
}
