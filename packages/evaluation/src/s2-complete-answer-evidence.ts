import { createHash } from "node:crypto";
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

/**
 * Supplemental opt-in S2.7 claim/slot diagnostics. Applicability is supplied
 * by a separate frozen review packet; it must NOT be inferred from the same
 * model's ALIGNED/UNKNOWN judgments. The reviewer identity is an audit hint,
 * never proof of independent human adjudication.
 */
export const S2_RELATION_FACETS = [
  "subject",
  "predicate",
  "direction",
  "polarity",
  "modality",
  "temporal",
  "conditions",
  "answerRole",
] as const;
export type S2RelationFacet = (typeof S2_RELATION_FACETS)[number];
export type S2RelationFacetApplicability =
  "APPLICABLE" | "NOT_APPLICABLE" | "UNRESOLVED";
export type S2RelationFacetModelObservation =
  "ALIGNED" | "CONFLICT" | "UNKNOWN";

export interface S2SourceBoundRelationFacetReview {
  /** One packet per exact writer claim; no reusing a decision across claims. */
  readonly claimIndex: number;
  readonly questionSha256: string;
  readonly claimSha256: string;
  readonly exactQuoteSha256: string;
  readonly sourceSha256: string;
  readonly reviewerId: string;
  readonly facets: readonly {
    readonly facet: S2RelationFacet;
    /** This scope is an external annotation, not a model prediction. */
    readonly applicability: S2RelationFacetApplicability;
    readonly modelObservation: S2RelationFacetModelObservation;
  }[];
}

export type S2RelationFacetAuditStatus =
  | "NOT_REQUESTED"
  | "SOURCE_OR_REVIEW_BINDING_INVALID"
  | "APPLICABILITY_REVIEW_REQUIRED"
  | "RELATION_CONFLICT_PROPOSED"
  | "APPLICABLE_OBSERVATION_UNCERTAIN"
  | "ALL_APPLICABLE_FACETS_ALIGNED_PROPOSAL_ONLY";
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const wellFormedUtf16 = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= text.length) return false;
      const low = text.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    }
  }
  return true;
};

/**
 * Runs only after F3 has bound each quote against an authorized original.
 * Neither NOT_APPLICABLE nor ALIGNED is a semantic verdict: annotation origin
 * and actual entailment still require independent checks outside this port.
 */
export function inspectS2SourceBoundRelationFacets(
  input: S2CompleteAnswerInput,
  claimResults: readonly S2SemanticEvidenceAssessment[],
  reviews: readonly S2SourceBoundRelationFacetReview[],
): S2RelationFacetAuditStatus {
  if (
    !Array.isArray(reviews) ||
    !Array.isArray(input?.claims) ||
    reviews.length !== input.claims.length ||
    claimResults.length !== input.claims.length ||
    typeof input.originalQuestion !== "string" ||
    !wellFormedUtf16(input.originalQuestion)
  )
    return "SOURCE_OR_REVIEW_BINDING_INVALID";
  let applicableCount = 0;
  let unresolved = false,
    conflict = false,
    unknown = false;
  for (let i = 0; i < input.claims.length; i++) {
    const claim = input.claims[i]!;
    const review = reviews[i];
    const attribution = claimResults[i]?.attribution;
    if (
      !review ||
      review.claimIndex !== i ||
      !attribution ||
      attribution.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
      attribution.sourceSha256 !== review.sourceSha256 ||
      typeof claim.claimText !== "string" ||
      typeof claim.evidenceQuote !== "string" ||
      typeof review.reviewerId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,100}@[A-Za-z0-9_.:-]{1,100}$/u.test(
        review.reviewerId,
      ) ||
      !wellFormedUtf16(claim.claimText) ||
      !wellFormedUtf16(claim.evidenceQuote) ||
      review.questionSha256 !== digest(input.originalQuestion) ||
      review.claimSha256 !== digest(claim.claimText) ||
      review.exactQuoteSha256 !== digest(claim.evidenceQuote) ||
      !Array.isArray(review.facets) ||
      review.facets.length !== S2_RELATION_FACETS.length ||
      attribution.startUtf16 === null ||
      attribution.endUtf16 === null
    )
      return "SOURCE_OR_REVIEW_BINDING_INVALID";
    const facets = new Set<string>();
    let claimApplicableCount = 0;
    for (const v of review.facets) {
      if (
        !v ||
        !S2_RELATION_FACETS.includes(v.facet) ||
        facets.has(v.facet) ||
        !["APPLICABLE", "NOT_APPLICABLE", "UNRESOLVED"].includes(
          v.applicability,
        ) ||
        !["ALIGNED", "CONFLICT", "UNKNOWN"].includes(v.modelObservation)
      )
        return "SOURCE_OR_REVIEW_BINDING_INVALID";
      facets.add(v.facet);
      if (v.applicability === "UNRESOLVED") unresolved = true;
      else if (v.applicability === "APPLICABLE") {
        applicableCount++;
        claimApplicableCount++;
        if (v.modelObservation === "CONFLICT") conflict = true;
        if (v.modelObservation === "UNKNOWN") unknown = true;
      }
    }
    // A different claim's reviewed relation must never stand in for this
    // claim's entirely unreviewed semantics. Even an all-N/A annotation
    // packet is not evidence that the statement is contextually sound.
    if (claimApplicableCount === 0) unresolved = true;
  }
  if (applicableCount === 0) return "APPLICABILITY_REVIEW_REQUIRED";
  if (unresolved) return "APPLICABILITY_REVIEW_REQUIRED";
  if (conflict) return "RELATION_CONFLICT_PROPOSED";
  if (unknown) return "APPLICABLE_OBSERVATION_UNCERTAIN";
  return "ALL_APPLICABLE_FACETS_ALIGNED_PROPOSAL_ONLY";
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
  /** Optional externally annotated facet applicability, shadow-only. */
  readonly sourceBoundRelationFacetReviews?: readonly S2SourceBoundRelationFacetReview[];
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
  readonly relationFacetAudit: S2RelationFacetAuditStatus;
  readonly relationFacetIndependentAdjudicationVerified: false;
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
  let relationFacetAudit: S2RelationFacetAuditStatus = "NOT_REQUESTED";
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
    relationFacetAudit,
    relationFacetIndependentAdjudicationVerified: false,
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

  if (config.sourceBoundRelationFacetReviews !== undefined) {
    relationFacetAudit = inspectS2SourceBoundRelationFacets(
      input,
      results,
      config.sourceBoundRelationFacetReviews,
    );
    if (relationFacetAudit !== "ALL_APPLICABLE_FACETS_ALIGNED_PROPOSAL_ONLY")
      return make("INSUFFICIENT", "RELATION_FACET_" + relationFacetAudit);
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
