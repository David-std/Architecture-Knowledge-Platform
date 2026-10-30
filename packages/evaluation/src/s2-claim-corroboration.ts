import { createHash } from "node:crypto";
import {
  attributeS2VerbatimQuote,
  type S2ExactQuoteOriginal,
} from "./s2-exact-quote-attribution.js";
import type { S2SemanticEvidenceAssessment } from "./s2-semantic-evidence.js";

const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const hex = /^[a-f0-9]{64}$/u;
/** Exact identity of the reviewer INPUT; never a certificate of model independence. */
export function s2CorroborationInputSha256(input: {
  question: string;
  claim: string;
  quote: string;
  original: S2ExactQuoteOriginal;
}): string {
  const bound = attributeS2VerbatimQuote(
    {
      answerText: input.claim,
      evidenceQuote: input.quote,
      sourceId: input.original.assignedSourceId,
      abstained: false,
    },
    [input.original],
  );
  if (
    bound.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
    !bound.modelSourceIdConfirmed ||
    bound.startUtf16 === null ||
    bound.endUtf16 === null
  )
    throw Error("S2_CORROBORATION_QUOTE_NOT_ORIGINAL");
  const parts = [
    input.question,
    input.claim,
    input.quote,
    input.original.assignedSourceId,
    input.original.sourceSha256,
    String(bound.startUtf16),
    String(bound.endUtf16),
  ];
  const h = createHash("sha256");
  for (const part of parts) {
    const b = Buffer.from(part, "utf8");
    h.update(String(b.length)).update(":").update(b);
  }
  return h.digest("hex");
}
export interface S2CorroborationReviewer {
  readonly declaredModelFamily: string;
  readonly modelDigestSha256: string;
  readonly providerResponseSha256: string;
  readonly boundInputSha256: string;
  readonly assessment: S2SemanticEvidenceAssessment;
}
export interface S2ClaimCorroborationResult {
  readonly status:
    | "REJECTED"
    | "WITHHELD_DISAGREEMENT"
    | "WITHHELD_CONTRADICTION_PROPOSAL"
    | "CORROBORATED_PROPOSAL_ONLY";
  readonly reason: string;
  readonly supportingReviews: number;
  readonly contradictedReviews: number;
  readonly uncertainReviews: number;
  readonly quoteSha256: string | null;
  readonly modelFamiliesCryptographicallyIndependent: false;
  readonly wholeAnswerSemanticsVerified: false;
  readonly sourcePermissionReauthenticated: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
/**
 * Shadow-only cross-reader guard. A single Gemma/Qwen SUPPORTED_CANDIDATE
 * can never yield even corroboration. Distinct declared model families and
 * provider-response receipts are necessary but NOT sufficient for causal
 * independence, nor is agreement a proof of factual entailment.
 */
export function reviewS2ClaimCorroboration(input: {
  question: string;
  claim: string;
  quote: string;
  original: S2ExactQuoteOriginal;
  reviewers: readonly S2CorroborationReviewer[];
}): S2ClaimCorroborationResult {
  const make = (
    status: S2ClaimCorroborationResult["status"],
    reason: string,
    yes = 0,
    no = 0,
    unk = 0,
  ): S2ClaimCorroborationResult => ({
    status,
    reason,
    supportingReviews: yes,
    contradictedReviews: no,
    uncertainReviews: unk,
    quoteSha256: typeof input.quote === "string" ? sha(input.quote) : null,
    modelFamiliesCryptographicallyIndependent: false,
    wholeAnswerSemanticsVerified: false,
    sourcePermissionReauthenticated: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    typeof input.question !== "string" ||
    !input.question.trim() ||
    input.question.length > 2048 ||
    typeof input.claim !== "string" ||
    !input.claim.trim() ||
    input.claim.length > 4096 ||
    typeof input.quote !== "string" ||
    input.quote.length < 12 ||
    input.quote.length > 12000 ||
    !Array.isArray(input.reviewers) ||
    input.reviewers.length < 2 ||
    input.reviewers.length > 4
  )
    return make("REJECTED", "INVALID_CORROBORATION_SCOPE_OR_QUORUM");
  let binding: string, bound: ReturnType<typeof attributeS2VerbatimQuote>;
  try {
    binding = s2CorroborationInputSha256(input);
    bound = attributeS2VerbatimQuote(
      {
        answerText: input.claim,
        evidenceQuote: input.quote,
        sourceId: input.original.assignedSourceId,
        abstained: false,
      },
      [input.original],
    );
  } catch {
    return make("REJECTED", "SOURCE_ORIGINAL_NOT_BOUND");
  }
  if (
    bound.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
    !bound.modelSourceIdConfirmed
  )
    return make("REJECTED", "SOURCE_NOT_CONFIRMED");
  const families = new Set<string>(),
    responses = new Set<string>(),
    probes = new Set<string>();
  let yes = 0,
    no = 0,
    uncertain = 0;
  for (const v of input.reviewers) {
    if (
      !v ||
      typeof v.declaredModelFamily !== "string" ||
      !/^[a-z][a-z0-9-]{2,79}$/u.test(v.declaredModelFamily) ||
      !hex.test(v.modelDigestSha256) ||
      !hex.test(v.providerResponseSha256) ||
      v.boundInputSha256 !== binding ||
      families.has(v.declaredModelFamily) ||
      responses.has(v.providerResponseSha256) ||
      !v.assessment?.questionProbeId?.includes("@") ||
      !v.assessment?.claimProbeId?.includes("@") ||
      v.assessment.questionProbeId === v.assessment.claimProbeId ||
      probes.has(v.assessment.questionProbeId) ||
      probes.has(v.assessment.claimProbeId)
    )
      return make(
        "REJECTED",
        "REVIEW_PROVENANCE_OR_FAMILY_COLLISION",
        yes,
        no,
        uncertain,
      );
    families.add(v.declaredModelFamily);
    responses.add(v.providerResponseSha256);
    probes.add(v.assessment.questionProbeId);
    probes.add(v.assessment.claimProbeId);
    const s = v.assessment,
      a = s.attribution;
    if (
      s.productionAdmission !== false ||
      s.releaseGateAccepted !== false ||
      a.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
      a.modelSourceIdConfirmed !== true ||
      a.modelSourceIdRepairedByLiteralProof !== false ||
      a.assignedSourceId !== bound.assignedSourceId ||
      a.sourceSha256 !== bound.sourceSha256 ||
      a.startUtf16 !== bound.startUtf16 ||
      a.endUtf16 !== bound.endUtf16
    )
      return make(
        "REJECTED",
        "REVIEW_ATTRIBUTION_OR_GATE_INVALID",
        yes,
        no,
        uncertain,
      );
    // Source identity does not prove subject/relation. Both independent stages
    // must affirm the *complete* claim, on actual original-quote spans.
    const span = (x: typeof s.questionRelevance) =>
      x?.decision === "SUPPORTS" &&
      typeof x.evidenceSpan?.startUtf16 === "number" &&
      typeof x.evidenceSpan?.endUtf16 === "number" &&
      Number.isSafeInteger(x.evidenceSpan.startUtf16) &&
      Number.isSafeInteger(x.evidenceSpan.endUtf16) &&
      x.evidenceSpan.startUtf16 >= 0 &&
      x.evidenceSpan.endUtf16 <= input.quote.length &&
      x.evidenceSpan.startUtf16 < x.evidenceSpan.endUtf16;
    if (
      s.status === "CONTRADICTED" ||
      s.claimEntailment?.decision === "CONTRADICTS"
    )
      no++;
    else if (
      s.status === "SUPPORTED_CANDIDATE" &&
      span(s.questionRelevance) &&
      span(s.claimEntailment)
    )
      yes++;
    else uncertain++;
  }
  if (no > 0)
    return make(
      "WITHHELD_CONTRADICTION_PROPOSAL",
      "ONE_REVIEW_PROPOSED_CONTRADICTION",
      yes,
      no,
      uncertain,
    );
  if (uncertain > 0 || yes !== input.reviewers.length)
    return make(
      "WITHHELD_DISAGREEMENT",
      "AT_LEAST_ONE_REVIEW_NOT_SOURCE_SUPPORTED",
      yes,
      no,
      uncertain,
    );
  return make(
    "CORROBORATED_PROPOSAL_ONLY",
    "MODELS_AGREE_BUT_ENTAILMENT_NOT_CERTIFIED",
    yes,
    no,
    uncertain,
  );
}
