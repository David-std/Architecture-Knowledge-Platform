import type { NativeWriterObservation } from "./s2-native-structured-writer.js";
import type { S2ClaimCorroborationResult } from "./s2-claim-corroboration.js";
import type { S2SemanticEvidenceAssessment } from "./s2-semantic-evidence.js";
import {
  attributeS2VerbatimQuote,
  type S2ExactQuoteOriginal,
} from "./s2-exact-quote-attribution.js";
import { createHash } from "node:crypto";

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
    if (result.status === "SUPPORTED_CANDIDATE") {
      const spanLength = attribution.endUtf16! - attribution.startUtf16!;
      const supportsWithBoundSpan = (
        step: typeof result.questionRelevance,
      ): boolean => {
        const bounds = step?.evidenceSpan;
        return (
          step?.decision === "SUPPORTS" &&
          typeof step.reason === "string" &&
          /^[A-Z][A-Z0-9_]{0,99}$/u.test(step.reason) &&
          bounds !== undefined &&
          Number.isSafeInteger(bounds.startUtf16) &&
          Number.isSafeInteger(bounds.endUtf16) &&
          bounds.startUtf16 >= 0 &&
          bounds.endUtf16 > bounds.startUtf16 &&
          bounds.endUtf16 <= spanLength
        );
      };
      if (
        !result.questionProbeId?.includes("@") ||
        !result.claimProbeId?.includes("@") ||
        result.questionProbeId === result.claimProbeId ||
        !supportsWithBoundSpan(result.questionRelevance) ||
        !supportsWithBoundSpan(result.claimEntailment)
      )
        return make(
          "STRUCTURALLY_REJECTED",
          "SEMANTIC_STAGES_NOT_SOURCE_BOUND",
        );
    }
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

/** Optional shadow cross-reader overlay on top of the existing F3 citation gate.
 * Not an alternate production path; only a different evidence-accounting view.
 */
export interface S2CorroboratedCitationReview extends S2ReviewedWriterCitation {
  readonly corroboration: S2ClaimCorroborationResult;
  /** Source bytes and exact quote are required; a reader-generated SHA is not trusted. */
  readonly original: S2ExactQuoteOriginal;
  readonly exactEvidenceQuote: string;
}
export interface S2CorroboratedWriterReconciliation {
  readonly status:
    | "CORROBORATED_PROPOSAL_ONLY"
    | "WITHHELD_UNCORROBORATED_SOURCE"
    | "WITHHELD_REVIEW_CONTRADICTION"
    | "REJECTED";
  readonly reason: string;
  readonly originalF3: S2WriterCitationReconciliation;
  readonly corroboratedCitations: number;
  readonly requiredCitations: number;
  readonly completeAnswerVerified: false;
  readonly independentHumanGoldVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
/**
 * Use the existing source/citation F3 gate before any multi-model agreement.
 * No quorum can repair an invalid citation, a missing atom, an invented
 * source ID or an initial insufficient stage. No relaxation of legacy gates.
 */
export function reconcileS2CorroboratedWriterCitations(
  observation: NativeWriterObservation,
  citedReviews: readonly S2CorroboratedCitationReview[],
): S2CorroboratedWriterReconciliation {
  const normal = reconcileS2WriterCitations(
    observation,
    Array.isArray(citedReviews)
      ? citedReviews.map((x) => ({
          citationId: x?.citationId,
          assessment: x?.assessment,
        }))
      : [],
  );
  const make = (
    status: S2CorroboratedWriterReconciliation["status"],
    reason: string,
    count = 0,
  ): S2CorroboratedWriterReconciliation => ({
    status,
    reason,
    originalF3: normal,
    corroboratedCitations: count,
    requiredCitations: observation?.citations?.length ?? 0,
    completeAnswerVerified: false,
    independentHumanGoldVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    !Array.isArray(citedReviews) ||
    citedReviews.length > 32 ||
    normal.status === "STRUCTURALLY_REJECTED" ||
    normal.status === "ABSTENTION_UNVERIFIED"
  )
    return make("REJECTED", "INITIAL_CITATION_CONTRACT_NOT_VALID");
  if (normal.status === "WITHHELD_CONTRADICTION")
    return make("WITHHELD_REVIEW_CONTRADICTION", "BASE_F3_CONTRADICTION");
  if (normal.status !== "SOURCE_BOUND_CANDIDATE")
    return make(
      "WITHHELD_UNCORROBORATED_SOURCE",
      "BASE_F3_SOURCE_NOT_SUPPORTED",
    );
  let passed = 0,
    uncertain = false,
    contradiction = false;
  for (const entry of citedReviews) {
    const proof = entry.corroboration;
    let sourceBound: ReturnType<typeof attributeS2VerbatimQuote> | null = null;
    try {
      if (entry?.original && typeof entry.exactEvidenceQuote === "string") {
        sourceBound = attributeS2VerbatimQuote(
          {
            answerText: observation.answerText ?? "",
            evidenceQuote: entry.exactEvidenceQuote,
            sourceId: entry.citationId,
            abstained: false,
          },
          [entry.original],
        );
      }
    } catch {
      // Untrusted malformed source objects must fail closed, not crash a
      // downstream receipt pipeline or turn a missing check into success.
      return make("REJECTED", "ORIGINAL_SOURCE_EVIDENCE_UNREADABLE", passed);
    }
    const prior = entry.assessment.attribution;
    if (
      !sourceBound ||
      sourceBound.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
      sourceBound.modelSourceIdConfirmed !== true ||
      sourceBound.sourceSha256 !== prior.sourceSha256 ||
      sourceBound.assignedSourceId !== prior.assignedSourceId ||
      sourceBound.startUtf16 !== prior.startUtf16 ||
      sourceBound.endUtf16 !== prior.endUtf16 ||
      proof?.quoteSha256 !==
        createHash("sha256").update(entry.exactEvidenceQuote).digest("hex") ||
      !proof ||
      !/^[a-f0-9]{64}$/u.test(proof.quoteSha256 ?? "") ||
      proof.releaseGateAccepted !== false ||
      proof.productionAdmission !== false ||
      proof.modelFamiliesCryptographicallyIndependent !== false ||
      proof.wholeAnswerSemanticsVerified !== false ||
      proof.sourcePermissionReauthenticated !== false ||
      !Number.isSafeInteger(proof.supportingReviews) ||
      !Number.isSafeInteger(proof.contradictedReviews) ||
      !Number.isSafeInteger(proof.uncertainReviews) ||
      proof.supportingReviews < 0 ||
      proof.contradictedReviews < 0 ||
      proof.uncertainReviews < 0 ||
      (proof.status === "CORROBORATED_PROPOSAL_ONLY" &&
        (proof.supportingReviews < 2 ||
          proof.uncertainReviews !== 0 ||
          proof.contradictedReviews !== 0))
    )
      return make("REJECTED", "REVIEW_RECEIPT_OR_PROVENANCE_INVALID", passed);
    if (
      proof.status === "WITHHELD_CONTRADICTION_PROPOSAL" &&
      proof.contradictedReviews > 0
    )
      contradiction = true;
    else if (
      proof.status === "CORROBORATED_PROPOSAL_ONLY" &&
      proof.supportingReviews >= 2 &&
      proof.contradictedReviews === 0 &&
      proof.uncertainReviews === 0
    )
      passed++;
    else uncertain = true;
  }
  if (contradiction)
    return make(
      "WITHHELD_REVIEW_CONTRADICTION",
      "MODEL_REVIEW_PROPOSED_CONTRADICTION",
      passed,
    );
  if (uncertain || passed !== citedReviews.length)
    return make(
      "WITHHELD_UNCORROBORATED_SOURCE",
      "ONE_OR_MORE_CITATIONS_UNCORROBORATED",
      passed,
    );
  return make(
    "CORROBORATED_PROPOSAL_ONLY",
    "ALL_CITATIONS_HAVE_NONAUTHORITATIVE_TWO_READER_PROPOSALS",
    passed,
  );
}
