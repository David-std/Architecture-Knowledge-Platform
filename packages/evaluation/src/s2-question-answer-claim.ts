import { createHash } from "node:crypto";
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
/** Optional second observation after the claim exists: unlike answer-role,
 * this receives the ACTUAL projected assertion, so it can flag misplaced
 * dates, wrong subjects, inverted predicates or missing qualifiers. */
export interface S2ProjectedClaimRoleProbe {
  readonly id: string;
  verify(input: {
    readonly originalQuestion: string;
    readonly proposedAnswer: string;
    readonly declarativeClaim: string;
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
    readonly declarativeClaim: string;
    readonly reason: string;
  }>;
}
export interface S2QuestionClaimCandidate {
  readonly status:
    | "CLAIM_CANDIDATE"
    | "ROLE_DISPUTED_CLAIM_CANDIDATE"
    | "FORM_DISPUTED_CLAIM_CANDIDATE"
    | "INSUFFICIENT"
    | "ERROR"
    | "REJECTED";
  readonly reason: string;
  readonly claimText: string | null;
  /** Surface-only, not a statement of role or source truth. */
  readonly projectionSurfaceStatus: S2ProjectionSurfaceStatus | null;
  /** Immutable identifier of the deterministic question/answer input pair. */
  readonly questionAnswerSha256: string | null;
  /** Value-in-claim lexical diagnostic, NOT projection equivalence or a veto. */
  readonly claimAnswerAnchor: S2ClaimAnswerAnchor | null;
  readonly roleDecision: "MATCH" | "MISMATCH" | "UNCERTAIN" | null;
  readonly roleProbeId: string | null;
  readonly claimProjectorId: string | null;
  readonly projectedClaimRoleDecision:
    "MATCH" | "MISMATCH" | "UNCERTAIN" | null;
  readonly projectedClaimRoleProbeId: string | null;
  readonly projectedRoleIndependenceVerified: false;
  readonly semanticsVerified: false;
  readonly sourceEntailmentVerified: false;
  readonly independentReviewVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
/** A conservative, language-neutral boundary: a question-shaped output cannot
 * be treated as a declarative claim, even if a model says MATCH. This does
 * NOT judge predicate, polarity or truth. Question marks in quoted statements
 * may cause a deliberate review hold, never an automatic falsehood claim. */
export type S2ProjectionSurfaceStatus =
  | "NO_INTERROGATIVE_MARKER_OBSERVED"
  | "INTERROGATIVE_SURFACE_REQUIRES_REWRITE"
  | "INVALID_PROJECTION_SURFACE";

export function inspectS2ProjectionSurface(
  claim: unknown,
): S2ProjectionSurfaceStatus {
  if (
    typeof claim !== "string" ||
    !claim.trim() ||
    claim.length > 4096 ||
    !wellFormedUtf16(claim)
  )
    return "INVALID_PROJECTION_SURFACE";
  const text = claim.trim();
  return /^¿/u.test(text) || /[?？]\s*$/u.test(text)
    ? "INTERROGATIVE_SURFACE_REQUIRES_REWRITE"
    : "NO_INTERROGATIVE_MARKER_OBSERVED";
}

const code = (v: unknown): boolean =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(v);
// Do not silently replace malformed UTF-16 with U+FFFD when the pair is
// hashed, serialized for a model, or rebound to a source span.
function wellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
const bound = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.trim() !== "" &&
  v.length <= max &&
  wellFormedUtf16(v);
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
  projectedRoleProbe?: S2ProjectedClaimRoleProbe,
): Promise<S2QuestionClaimCandidate> {
  const make = (
    status: S2QuestionClaimCandidate["status"],
    reason: string,
    claimText: string | null = null,
    roleDecision: S2QuestionClaimCandidate["roleDecision"] = null,
    projectedClaimRoleDecision: S2QuestionClaimCandidate["projectedClaimRoleDecision"] = null,
  ): S2QuestionClaimCandidate => ({
    status,
    reason,
    claimText,
    projectionSurfaceStatus:
      claimText === null ? null : inspectS2ProjectionSurface(claimText),
    questionAnswerSha256:
      bound(originalQuestion, 2048) && bound(proposedAnswer, 2048)
        ? createHash("sha256")
            .update(originalQuestion)
            .update(Buffer.from([0]))
            .update(proposedAnswer)
            .digest("hex")
        : null,
    claimAnswerAnchor:
      claimText === null
        ? null
        : checkS2ClaimAnswerAnchor(proposedAnswer, claimText),
    roleDecision,
    roleProbeId: roleProbe?.id ?? null,
    claimProjectorId: projector?.id ?? null,
    projectedClaimRoleDecision,
    projectedClaimRoleProbeId: projectedRoleProbe?.id ?? null,
    projectedRoleIndependenceVerified: false,
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
    typeof projector.project !== "function" ||
    (projectedRoleProbe !== undefined &&
      (!projectedRoleProbe.id?.includes("@") ||
        projectedRoleProbe.id === roleProbe.id ||
        projectedRoleProbe.id === projector.id ||
        typeof projectedRoleProbe.verify !== "function"))
  )
    return make("REJECTED", "QUESTION_ANSWER_OR_PROBE_INVALID");
  try {
    // The role check and projection run as separate calls, but distinct
    // IDs do NOT establish model independence, truth or source sufficiency.
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
      Object.keys(claim).sort().join(",") !== "declarativeClaim,reason" ||
      claim.declarativeClaim.trim() !== claim.declarativeClaim ||
      claim.declarativeClaim.length < 12
    )
      return make("INSUFFICIENT", "CLAIM_PROJECTION_INVALID");
    let projectedDecision: S2QuestionClaimCandidate["projectedClaimRoleDecision"] =
      null;
    if (projectedRoleProbe) {
      try {
        const observed = await projectedRoleProbe.verify({
          originalQuestion,
          proposedAnswer,
          declarativeClaim: claim.declarativeClaim,
        });
        if (
          !observed ||
          !code(observed.reason) ||
          !["MATCH", "MISMATCH", "UNCERTAIN"].includes(observed.decision) ||
          Object.keys(observed).sort().join(",") !== "decision,reason"
        )
          return make(
            "ERROR",
            "PROJECTED_ROLE_RESULT_INVALID",
            claim.declarativeClaim,
            role.decision,
          );
        projectedDecision = observed.decision;
      } catch {
        return make(
          "ERROR",
          "PROJECTED_ROLE_CHECK_FAILED",
          claim.declarativeClaim,
          role.decision,
        );
      }
    }
    const interrogativeSurface =
      inspectS2ProjectionSurface(claim.declarativeClaim) ===
      "INTERROGATIVE_SURFACE_REQUIRES_REWRITE";
    const roleDisputed =
      role.decision !== "MATCH" ||
      (projectedDecision !== null && projectedDecision !== "MATCH");
    return make(
      interrogativeSurface
        ? "FORM_DISPUTED_CLAIM_CANDIDATE"
        : roleDisputed
          ? "ROLE_DISPUTED_CLAIM_CANDIDATE"
          : "CLAIM_CANDIDATE",
      interrogativeSurface
        ? "INTERROGATIVE_PROJECTION_NOT_A_DECLARATIVE_CLAIM"
        : roleDisputed
          ? projectedDecision === null
            ? "ROLE_PROBE_DISPUTED_NOT_A_SEMANTIC_VETO"
            : "PROJECTED_OR_ANSWER_ROLE_DISPUTED_NOT_A_SEMANTIC_VETO"
          : "UNVERIFIED_FULL_QUESTION_CLAIM",
      claim.declarativeClaim,
      role.decision,
      projectedDecision,
    );
  } catch {
    return make("ERROR", "QUESTION_ROLE_OR_PROJECTION_FAILED");
  }
}

/**
 * Contract-level answer preservation for a source-independent writer claim.
 * The projector builds only a grammatical template with ONE immutable slot;
 * the application, not the model, inserts the actual candidate answer bytes.
 * A slot-bound projection is NOT a verified grammatical role, question
 * equivalence, actual source entailment, or production authorization.
 */
export const S2_IMMUTABLE_ANSWER_SLOT = "__AKP_ANSWER_SLOT__" as const;

export interface S2AnswerSlotTemplateProjector {
  readonly id: string;
  projectTemplate(input: {
    readonly originalQuestion: string;
    readonly proposedAnswer: string;
    readonly answerSlotMarker: typeof S2_IMMUTABLE_ANSWER_SLOT;
  }): Promise<{
    readonly template: string;
    readonly reason: string;
  }>;
}

export function createS2ImmutableAnswerSlotProjector(
  worker: S2AnswerSlotTemplateProjector,
): S2DeclarativeClaimProjector {
  return {
    id: worker?.id ?? "",
    async project({ originalQuestion, proposedAnswer }) {
      const invalid = () => ({
        declarativeClaim: "",
        reason: "ANSWER_SLOT_TEMPLATE_INVALID",
      });
      if (
        !bound(originalQuestion, 2048) ||
        !bound(proposedAnswer, 2048) ||
        proposedAnswer.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(proposedAnswer) ||
        originalQuestion.includes(S2_IMMUTABLE_ANSWER_SLOT) ||
        proposedAnswer.includes(S2_IMMUTABLE_ANSWER_SLOT) ||
        !worker?.id?.includes("@") ||
        typeof worker.projectTemplate !== "function"
      )
        return invalid();
      let projected: Awaited<
        ReturnType<S2AnswerSlotTemplateProjector["projectTemplate"]>
      >;
      try {
        projected = await worker.projectTemplate({
          originalQuestion,
          proposedAnswer,
          answerSlotMarker: S2_IMMUTABLE_ANSWER_SLOT,
        });
      } catch {
        return {
          declarativeClaim: "",
          reason: "ANSWER_SLOT_PROJECTOR_FAILED",
        };
      }
      if (
        !projected ||
        typeof projected.template !== "string" ||
        !wellFormedUtf16(projected.template) ||
        Object.keys(projected).sort().join(",") !== "reason,template" ||
        !code(projected.reason) ||
        projected.template.trim() !== projected.template ||
        projected.template.length < 12 ||
        projected.template.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(projected.template)
      )
        return invalid();
      const first = projected.template.indexOf(S2_IMMUTABLE_ANSWER_SLOT);
      if (
        first < 0 ||
        projected.template.indexOf(
          S2_IMMUTABLE_ANSWER_SLOT,
          first + S2_IMMUTABLE_ANSWER_SLOT.length,
        ) !== -1
      )
        return invalid();
      const prefix = projected.template.slice(0, first);
      const suffix = projected.template.slice(
        first + S2_IMMUTABLE_ANSWER_SLOT.length,
      );
      const priorCodePoint = [...prefix].at(-1);
      const nextCodePoint = [...suffix][0];
      // The slot stands for a whole answer value, never part of a word.
      const wordPart = /[\p{L}\p{M}\p{N}_]/u;
      if (
        (priorCodePoint !== undefined && wordPart.test(priorCodePoint)) ||
        (nextCodePoint !== undefined && wordPart.test(nextCodePoint))
      )
        return invalid();
      const declarativeClaim = prefix + proposedAnswer + suffix;
      if (!bound(declarativeClaim, 4096) || declarativeClaim.length < 12)
        return invalid();
      // The sole model-controlled marker, not lexical word uniqueness,
      // determines the answer's immutable placement. A key named
      // "permissions" may legitimately change permissions. Detect that
      // repetition without treating it as semantic mismatch or a hard veto.
      const anchor = checkS2ClaimAnswerAnchor(proposedAnswer, declarativeClaim);
      return {
        declarativeClaim,
        reason:
          anchor.status === "REPEATED_LITERAL_VALUE"
            ? "SLOT_BOUND_REPEATED_VALUE_SEMANTICS_UNVERIFIED"
            : anchor.status === "BOOLEAN_VALUE_REQUIRES_SEMANTIC_REWRITE"
              ? "SLOT_BOUND_BOOLEAN_SEMANTICS_UNVERIFIED"
              : "IMMUTABLE_ANSWER_SLOT_SURFACE_ONLY",
      };
    },
  };
}

/**
 * Native JSON schema for the post-projection question/answer/claim role
 * reviewer. The decision and rationale class are ONE frozen enum token:
 * a reviewer can no longer return MATCH together with UNSURE or claim a
 * MISMATCH without naming the disputed role. This is output-contract
 * integrity only, not a certificate that the model's role judgement is true.
 */
export const S2_POST_PROJECTION_ROLE_TOKENS = [
  "MATCH@NONE",
  "UNCERTAIN@UNSURE",
  "MISMATCH@MISSING_ANSWER_ROLE",
  "MISMATCH@TIME_OR_NUMBER_AS_AGENT",
  "MISMATCH@SUBJECT_OBJECT_INVERSION",
  "MISMATCH@RELATION_CHANGED",
  "MISMATCH@QUALIFIER_OR_POLARITY_CHANGED",
  "MISMATCH@OTHER",
] as const;

export function buildS2ProjectedRoleTokenFormat() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdictToken"],
    properties: {
      verdictToken: { type: "string", enum: S2_POST_PROJECTION_ROLE_TOKENS },
    },
  } as const;
}

export function resolveS2ProjectedRoleToken(response: unknown): {
  readonly status: "VALID_ROLE_PROPOSAL_ONLY" | "REJECTED";
  readonly decision: "MATCH" | "MISMATCH" | "UNCERTAIN";
  readonly failureKind: string | null;
  readonly roleEquivalenceVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
} {
  const fail = () => ({
    status: "REJECTED" as const,
    decision: "UNCERTAIN" as const,
    failureKind: null,
    roleEquivalenceVerified: false as const,
    productionAdmission: false as const,
    releaseGateAccepted: false as const,
  });
  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response) ||
    Object.keys(response).join(",") !== "verdictToken"
  )
    return fail();
  const token = (response as { verdictToken?: unknown }).verdictToken;
  if (
    typeof token !== "string" ||
    !(S2_POST_PROJECTION_ROLE_TOKENS as readonly string[]).includes(token)
  )
    return fail();
  const [decision, failureKind] = token.split("@") as [
    "MATCH" | "MISMATCH" | "UNCERTAIN",
    string,
  ];
  return {
    status: "VALID_ROLE_PROPOSAL_ONLY",
    decision,
    failureKind,
    roleEquivalenceVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}
