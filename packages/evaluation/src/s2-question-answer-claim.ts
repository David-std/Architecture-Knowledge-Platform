import {
  checkS2ClaimAnswerAnchor,
  type S2ClaimAnswerAnchor,
} from "./s2-claim-answer-anchor.js";

/** Shadow-only question/answer role binding before full-claim F3.
 * A bare lexical answer in a quote need not fill the requested answer slot.
 * Neither a model's role decision nor its claim rewrite establishes truth.
 */
export interface S2AnswerRoleProbe {
  readonly id: string;
  verify(input: {
    readonly originalQuestion: string;
    readonly proposedAnswer: string;
  }): Promise<{
    readonly decision: "MATCH" | "MISMATCH" | "UNCERTAIN";
    readonly reason: string;
  }>;
}
export interface S2DeclarativeClaimProjector {
  readonly id: string;
  project(input: {
    readonly originalQuestion: string;
    readonly proposedAnswer: string;
  }): Promise<{
    readonly answerEcho: string;
    readonly declarativeClaim: string;
    readonly reason: string;
  }>;
}
export interface S2QuestionClaimCandidate {
  readonly status:
    | "CLAIM_CANDIDATE"
    | "ROLE_DISPUTED_CLAIM_CANDIDATE"
    | "INSUFFICIENT"
    | "ERROR"
    | "REJECTED";
  readonly reason: string;
  readonly claimText: string | null;
  /** Value-in-claim lexical diagnostic, NOT projection equivalence or a veto. */
  readonly claimAnswerAnchor: S2ClaimAnswerAnchor | null;
  readonly roleDecision: "MATCH" | "MISMATCH" | "UNCERTAIN" | null;
  readonly roleProbeId: string | null;
  readonly claimProjectorId: string | null;
  readonly semanticsVerified: false;
  readonly sourceEntailmentVerified: false;
  readonly independentReviewVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
const code = (v: unknown): boolean =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(v);
const bound = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim() !== "" && v.length <= max;
/**
 * Project the complete original question and a proposed short answer into a
 * declarative hypothesis without source text, label hints or answer-key data.
 * Does NOT turn a projected claim into evidence, authorization or acceptance.
 */
export async function prepareS2QuestionAnswerClaim(
  originalQuestion: string,
  proposedAnswer: string,
  roleProbe: S2AnswerRoleProbe,
  projector: S2DeclarativeClaimProjector,
): Promise<S2QuestionClaimCandidate> {
  const make = (
    status: S2QuestionClaimCandidate["status"],
    reason: string,
    claimText: string | null = null,
    roleDecision: S2QuestionClaimCandidate["roleDecision"] = null,
  ): S2QuestionClaimCandidate => ({
    status,
    reason,
    claimText,
    claimAnswerAnchor:
      claimText === null
        ? null
        : checkS2ClaimAnswerAnchor(proposedAnswer, claimText),
    roleDecision,
    roleProbeId: roleProbe?.id ?? null,
    claimProjectorId: projector?.id ?? null,
    semanticsVerified: false,
    sourceEntailmentVerified: false,
    independentReviewVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    !bound(originalQuestion, 2048) ||
    !bound(proposedAnswer, 2048) ||
    !roleProbe?.id?.includes("@") ||
    !projector?.id?.includes("@") ||
    roleProbe.id === projector.id ||
    typeof roleProbe.verify !== "function" ||
    typeof projector.project !== "function"
  )
    return make("REJECTED", "QUESTION_ANSWER_OR_PROBE_INVALID");
  try {
    // Both independent model observations can run concurrently. Neither
    // establishes factual support or source-level sufficiency.
    const [role, claim] = await Promise.all([
      roleProbe.verify({ originalQuestion, proposedAnswer }),
      projector.project({ originalQuestion, proposedAnswer }),
    ]);
    if (
      !role ||
      !code(role.reason) ||
      !["MATCH", "MISMATCH", "UNCERTAIN"].includes(role.decision)
    )
      return make("ERROR", "ROLE_PROBE_INVALID_RESULT");
    if (
      !claim ||
      !bound(claim.declarativeClaim, 4096) ||
      !code(claim.reason) ||
      claim.answerEcho !== proposedAnswer ||
      claim.declarativeClaim.trim() !== claim.declarativeClaim ||
      claim.declarativeClaim.length < 12
    )
      return make("INSUFFICIENT", "CLAIM_ECHO_OR_PROJECTION_INVALID");
    return make(
      role.decision === "MATCH"
        ? "CLAIM_CANDIDATE"
        : "ROLE_DISPUTED_CLAIM_CANDIDATE",
      role.decision === "MATCH"
        ? "UNVERIFIED_FULL_QUESTION_CLAIM"
        : "ROLE_PROBE_DISPUTED_NOT_A_SEMANTIC_VETO",
      claim.declarativeClaim,
      role.decision,
    );
  } catch {
    return make("ERROR", "QUESTION_ROLE_OR_PROJECTION_FAILED");
  }
}
