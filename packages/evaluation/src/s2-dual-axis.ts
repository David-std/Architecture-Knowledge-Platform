import { createHash } from "node:crypto";
import type { BlindReviewerSubmission } from "./s2-section-blind-review.js";

/**
 * Development-only reinterpretation. It NEVER overwrites the original four-way
 * adjudications or treats an explicit "No" as a positive proposition.
 */
export type ResponseEvidenceDisposition =
  "EXPLICITLY_DECIDABLE" | "NOT_SUPPORTED" | "AMBIGUOUS" | "DISPUTED";
export type ClaimPolarityResolution =
  | "BOTH_MARKED_CONTRADICTED"
  | "BOTH_MARKED_ANSWERABLE_EXPLICIT"
  | "MIXED_CONTRADICTED_AND_EXPLICIT"
  | "NOT_APPLICABLE"
  | "UNRESOLVED";
export interface DualAxisCase {
  questionKeySha256: string;
  reviewerAOriginalVerdict: string;
  reviewerBOriginalVerdict: string;
  evidenceDisposition: ResponseEvidenceDisposition;
  claimPolarityReview: ClaimPolarityResolution;
  strictFourWayAgreement: boolean;
}
export interface DualAxisReport {
  schemaVersion: "akp.s2.section-dual-axis-dev.v1";
  status: "PROVISIONAL_ANNOTATION_ONLY";
  aSubmissionSha256: string;
  bSubmissionSha256: string;
  caseCount: number;
  exactFourWayAgreement: number;
  evidenceDispositionAgreement: number;
  resolvedExplicitlyDecidable: number;
  resolvedNotSupported: number;
  resolvedAmbiguous: number;
  disputedEvidenceDisposition: number;
  claimPolarityNeedsReview: number;
  cases: DualAxisCase[];
  independentReviewerProcedureAttested: false;
  semanticAnswersIndependentlyAdjudicated: false;
  falseAdmissionRate: null;
  gateAccepted: false;
}
const sha = (input: Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const fourWay = new Set([
  "ANSWERABLE_EXPLICIT",
  "CONTRADICTED",
  "NOT_ANSWERABLE",
  "AMBIGUOUS",
]);
const supported = (label: string) =>
  label === "ANSWERABLE_EXPLICIT" || label === "CONTRADICTED";
function disposition(
  label: string,
): Exclude<ResponseEvidenceDisposition, "DISPUTED"> {
  if (supported(label)) return "EXPLICITLY_DECIDABLE";
  if (label === "NOT_ANSWERABLE") return "NOT_SUPPORTED";
  return "AMBIGUOUS";
}
function parse(bytes: Uint8Array, assignment: "A" | "B") {
  if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000)
    throw new Error("S2_DUAL_AXIS_INVALID_SUBMISSION_BYTES");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("S2_DUAL_AXIS_INVALID_SUBMISSION_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("S2_DUAL_AXIS_INVALID_SUBMISSION");
  const result = parsed as Record<string, unknown>;
  if (
    Object.keys(result).sort().join(",") !==
      "cases,packetSha256,reviewerAssignment,schemaVersion" ||
    result.schemaVersion !== "akp.s2.section-blind-review-submission.v1" ||
    result.reviewerAssignment !== assignment ||
    typeof result.packetSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(result.packetSha256) ||
    !Array.isArray(result.cases) ||
    result.cases.length === 0 ||
    result.cases.length > 10_000
  )
    throw new Error("S2_DUAL_AXIS_INVALID_SUBMISSION");
  const verdicts = new Map<string, string>();
  for (const row of result.cases) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("S2_DUAL_AXIS_INVALID_CASE");
    const v = row as Record<string, unknown>;
    if (
      Object.keys(v).sort().join(",") !==
        "answerText,answerability,note,questionKey,quotes" ||
      typeof v.questionKey !== "string" ||
      !/^[a-f0-9]{64}$/u.test(v.questionKey) ||
      !fourWay.has(String(v.answerability)) ||
      verdicts.has(v.questionKey)
    )
      throw new Error("S2_DUAL_AXIS_INVALID_CASE");
    verdicts.set(v.questionKey, v.answerability as string);
  }
  return verdicts;
}
/**
 * Requires a prior complete original-source audit; this function does not
 * revalidate source byte offsets, reviewer identity or semantic correctness.
 * SHA parameters refer to actual uploaded submission bytes.
 */
export function summarizeDualAxisReviews(input: {
  submissionABytes: Uint8Array;
  submissionBBytes: Uint8Array;
  auditedQuestionKeys: readonly string[];
  structuralAuditStatus: "TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED";
}): DualAxisReport {
  if (input.structuralAuditStatus !== "TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED")
    throw new Error("S2_DUAL_AXIS_PRECONDITION_NOT_VERIFIED");
  const A = parse(input.submissionABytes, "A"),
    B = parse(input.submissionBBytes, "B");
  const keys = input.auditedQuestionKeys;
  if (
    keys.length === 0 ||
    new Set(keys).size !== keys.length ||
    keys.some((x) => !/^[a-f0-9]{64}$/u.test(x)) ||
    keys.length !== A.size ||
    keys.length !== B.size ||
    keys.some((x) => !A.has(x) || !B.has(x))
  )
    throw new Error("S2_DUAL_AXIS_CASE_SCOPE_MISMATCH");
  const cases: DualAxisCase[] = keys.map((questionKeySha256) => {
    const a = A.get(questionKeySha256)!,
      b = B.get(questionKeySha256)!;
    const dA = disposition(a),
      dB = disposition(b);
    const isPositive = supported(a) && supported(b);
    let claimPolarityReview: ClaimPolarityResolution = "UNRESOLVED";
    if (dA === dB && dA !== "EXPLICITLY_DECIDABLE")
      claimPolarityReview = "NOT_APPLICABLE";
    else if (isPositive) {
      if (a === "CONTRADICTED" && b === "CONTRADICTED")
        claimPolarityReview = "BOTH_MARKED_CONTRADICTED";
      else if (a === "ANSWERABLE_EXPLICIT" && b === "ANSWERABLE_EXPLICIT")
        claimPolarityReview = "BOTH_MARKED_ANSWERABLE_EXPLICIT";
      else claimPolarityReview = "MIXED_CONTRADICTED_AND_EXPLICIT";
    }
    return {
      questionKeySha256,
      reviewerAOriginalVerdict: a,
      reviewerBOriginalVerdict: b,
      evidenceDisposition: dA === dB ? dA : "DISPUTED",
      claimPolarityReview,
      strictFourWayAgreement: a === b,
    };
  });
  return {
    schemaVersion: "akp.s2.section-dual-axis-dev.v1",
    status: "PROVISIONAL_ANNOTATION_ONLY",
    aSubmissionSha256: sha(input.submissionABytes),
    bSubmissionSha256: sha(input.submissionBBytes),
    caseCount: cases.length,
    exactFourWayAgreement: cases.filter((c) => c.strictFourWayAgreement).length,
    evidenceDispositionAgreement: cases.filter(
      (c) => c.evidenceDisposition !== "DISPUTED",
    ).length,
    resolvedExplicitlyDecidable: cases.filter(
      (c) => c.evidenceDisposition === "EXPLICITLY_DECIDABLE",
    ).length,
    resolvedNotSupported: cases.filter(
      (c) => c.evidenceDisposition === "NOT_SUPPORTED",
    ).length,
    resolvedAmbiguous: cases.filter(
      (c) => c.evidenceDisposition === "AMBIGUOUS",
    ).length,
    disputedEvidenceDisposition: cases.filter(
      (c) => c.evidenceDisposition === "DISPUTED",
    ).length,
    claimPolarityNeedsReview: cases.filter(
      (c) => c.evidenceDisposition === "EXPLICITLY_DECIDABLE",
    ).length,
    cases,
    independentReviewerProcedureAttested: false,
    semanticAnswersIndependentlyAdjudicated: false,
    falseAdmissionRate: null,
    gateAccepted: false,
  };
}
