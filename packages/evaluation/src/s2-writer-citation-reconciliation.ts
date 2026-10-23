import type { NativeWriterObservation } from "./s2-native-structured-writer.js";
import type { S2SemanticEvidenceAssessment } from "./s2-semantic-evidence.js";

export interface S2ReviewedWriterCitation {
  readonly citationId: string;
  readonly assessment: S2SemanticEvidenceAssessment;
}

export interface S2WriterCitationReconciliation {
  readonly status:
    | "SOURCE_BOUND_CANDIDATE"
    | "WITHHELD_UNSUPPORTED_CITATION"
    | "WITHHELD_CONTRADICTION"
    | "STRUCTURALLY_REJECTED"
    | "ABSTENTION_UNVERIFIED";
  readonly reason: string;
  readonly sourceBoundCitations: number;
  readonly requiredCitations: number;
  /** Semantic citation checks cannot prove the answer is complete or correct. */
  readonly completeAnswerVerified: false;
  readonly independentSemanticReviewVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

/**
 * Evaluation-only adapter for the native-writer citation ID contract and the
 * existing two-stage F→question→claim semantic assessments. All citations
 * must have a distinct, matching source-bound review; no score, hit ranking,
 * repair, or partial support is promoted into answer authority.
 *
 * This does not replace assessS2CompleteAnswer, which separately checks
 * claim coverage, context, atomicity, consistency and completeness.
 */
export function reconcileS2WriterCitations(
  observation: NativeWriterObservation,
  reviews: readonly S2ReviewedWriterCitation[],
): S2WriterCitationReconciliation {
  const make = (
    status: S2WriterCitationReconciliation["status"],
    reason: string,
    count = 0,
  ): S2WriterCitationReconciliation => ({
    status,
    reason,
    sourceBoundCitations: count,
    requiredCitations: observation.citations.length,
    completeAnswerVerified: false,
    independentSemanticReviewVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    observation.status !== "STRUCTURALLY_VALID" ||
    observation.gateAccepted !== false ||
    !Array.isArray(reviews) ||
    reviews.length > 32
  )
    return make("STRUCTURALLY_REJECTED", "WRITER_OR_REVIEWS_NOT_VALID");
  if (observation.abstained === true) {
    return observation.answerText === "" &&
      observation.citations.length === 0 &&
      reviews.length === 0
      ? make("ABSTENTION_UNVERIFIED", "ABSTENTION_REQUIRES_SOURCE_REVIEW")
      : make("STRUCTURALLY_REJECTED", "ABSTENTION_REVIEW_CONFLICT");
  }
  if (
    observation.abstained !== false ||
    !observation.answerText?.trim() ||
    observation.citations.length === 0 ||
    reviews.length !== observation.citations.length
  )
    return make("STRUCTURALLY_REJECTED", "CITATION_REVIEW_SET_INCOMPLETE");
  const cited = new Set(observation.citations);
  const reviewed = new Set<string>();
  for (const review of reviews) {
    const result = review.assessment;
    const attribution = result?.attribution;
    if (
      !review.citationId ||
      !cited.has(review.citationId) ||
      reviewed.has(review.citationId) ||
      result?.productionAdmission !== false ||
      result?.releaseGateAccepted !== false ||
      attribution?.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
      attribution.assignedSourceId !== review.citationId ||
      attribution.modelSourceIdConfirmed !== true ||
      attribution.modelSourceIdRepairedByLiteralProof !== false ||
      typeof attribution.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(attribution.sourceSha256) ||
      !Number.isSafeInteger(attribution.startUtf16) ||
      !Number.isSafeInteger(attribution.endUtf16) ||
      attribution.startUtf16! < 0 ||
      attribution.endUtf16! <= attribution.startUtf16!
    )
      return make("STRUCTURALLY_REJECTED", "CITATION_ATTRIBUTION_UNTRUSTED");
    reviewed.add(review.citationId);
  }
  if (reviews.some((entry) => entry.assessment.status === "CONTRADICTED"))
    return make("WITHHELD_CONTRADICTION", "CITED_SOURCE_CONTRADICTS_ANSWER");
  const eligible = reviews.filter(
    (entry) => entry.assessment.status === "SUPPORTED_CANDIDATE",
  );
  if (eligible.length !== reviews.length)
    return make("WITHHELD_UNSUPPORTED_CITATION", "CITED_SOURCE_NOT_ENTAILING");
  return make(
    "SOURCE_BOUND_CANDIDATE",
    "ALL_CITED_SOURCES_PROPOSE_SUPPORT",
    eligible.length,
  );
}
