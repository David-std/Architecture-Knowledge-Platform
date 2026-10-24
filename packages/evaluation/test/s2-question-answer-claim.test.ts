import { describe, it, expect, vi } from "vitest";
import { prepareS2QuestionAnswerClaim } from "../src/s2-question-answer-claim.js";
const question =
  "Which object is responsible for granting access to a resource?";
const role = (decision: "MATCH" | "MISMATCH" | "UNCERTAIN" = "MATCH") => ({
  id: "separate-role-verifier@pinned-v1",
  verify: vi.fn(async () => ({
    decision,
    reason: "QUESTION_ANSWER_SLOT_" + decision,
  })),
});
const claim = (
  s = "The access control proxy grants access to a resource.",
  echo = "access control proxy",
) => ({
  id: "claim-projector@pinned-v1",
  project: vi.fn(async () => ({
    answerEcho: echo,
    declarativeClaim: s,
    reason: "ATOMIC_CLAIM_PROJECTED",
  })),
});
describe("question answer role and full declarative claim shadow bridge", () => {
  it("retains an unverified candidate with no source or production authority", async () => {
    const v = await prepareS2QuestionAnswerClaim(
      question,
      "access control proxy",
      role(),
      claim(),
    );
    expect(v).toMatchObject({
      status: "CLAIM_CANDIDATE",
      claimText: "The access control proxy grants access to a resource.",
      claimAnswerAnchor: {
        status: "UNIQUE_LITERAL_VALUE",
        claimEquivalenceVerified: false,
        sourceEntailmentVerified: false,
      },
      semanticsVerified: false,
      sourceEntailmentVerified: false,
      productionAdmission: false,
      independentReviewVerified: false,
      releaseGateAccepted: false,
    });
  });
  it("does not turn an unreliable answer-type mismatch into a semantic veto", async () => {
    const rv = role("MISMATCH");
    const projection = claim(
      "El método establece una cabecera.",
      "Establece una cabecera.",
    );
    const result = await prepareS2QuestionAnswerClaim(
      "¿Qué método establece una cabecera?",
      "Establece una cabecera.",
      rv,
      projection,
    );
    expect(result.status).toBe("ROLE_DISPUTED_CLAIM_CANDIDATE");
    expect(result.roleDecision).toBe("MISMATCH");
    expect(result.claimAnswerAnchor?.status).toBe("UNIQUE_LITERAL_VALUE");
    expect(projection.project).toHaveBeenCalledOnce();
    expect(result.sourceEntailmentVerified).toBe(false);
  });
  it("stays insufficient on unsupported multilingual or negated role assessments", async () => {
    const r = await prepareS2QuestionAnswerClaim(
      "¿Qué opción se activa solo después de aprobar una solicitud?",
      "yes",
      role("UNCERTAIN"),
      claim("La opción se activa después de aprobar una solicitud.", "yes"),
    );
    expect(r.status).toBe("ROLE_DISPUTED_CLAIM_CANDIDATE");
    expect(r.claimAnswerAnchor?.status).toBe(
      "BOOLEAN_VALUE_REQUIRES_SEMANTIC_REWRITE",
    );
  });
  it("exposes omitted answer values even with a correct answerEcho and MATCH role", async () => {
    const result = await prepareS2QuestionAnswerClaim(
      question,
      "access control proxy",
      role(),
      claim(
        "The administrator grants access to a resource.",
        "access control proxy",
      ),
    );
    expect(result.status).toBe("CLAIM_CANDIDATE");
    expect(result.claimAnswerAnchor?.status).toBe("LITERAL_VALUE_NOT_FOUND");
    expect(result.claimAnswerAnchor?.claimEquivalenceVerified).toBe(false);
    expect(result.sourceEntailmentVerified).toBe(false);
  });
  it("rejects a hallucinated answer rewrite even when the role model passed", async () => {
    const result = await prepareS2QuestionAnswerClaim(
      question,
      "access control proxy",
      role(),
      claim("The administrator grants access to a resource.", "administrator"),
    );
    expect(result.status).toBe("INSUFFICIENT");
  });
  it("preserves a disputed question-role hypothesis only as a non-authoritative diagnostic", async () => {
    const answer = "access control proxy";
    const r = await prepareS2QuestionAnswerClaim(
      question,
      answer,
      role("MISMATCH"),
      claim(),
    );
    expect(r).toMatchObject({
      status: "ROLE_DISPUTED_CLAIM_CANDIDATE",
      roleDecision: "MISMATCH",
      claimText: "The access control proxy grants access to a resource.",
      sourceEntailmentVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
    expect(r.status).not.toBe("CLAIM_CANDIDATE");
  });
  it("rejects a paraphrased answer echo even if the claim incidentally contains the answer", async () => {
    const result = await prepareS2QuestionAnswerClaim(
      "Are the directives case-sensitive?",
      "case-insensitive",
      role("UNCERTAIN"),
      claim(
        "The directives are case-insensitive.",
        "The directives are not case-sensitive.",
      ),
    );
    expect(result.status).toBe("INSUFFICIENT");
    expect(result.claimText).toBeNull();
  });
  it("does not accept malformed inference, errors, or unpinned same verifier identities", async () => {
    const bad = await prepareS2QuestionAnswerClaim(
      question,
      "access control proxy",
      {
        id: "reader",
        verify: async () => ({ decision: "MATCH" as const, reason: "OK" }),
      },
      claim(),
    );
    expect(bad.status).toBe("REJECTED");
    const wrong = await prepareS2QuestionAnswerClaim(
      question,
      "access control proxy",
      {
        id: "role@pinned",
        verify: async () => ({
          decision: "MATCH" as const,
          reason: "a raw invalid reason",
        }),
      },
      claim(),
    );
    expect(wrong.status).toBe("ERROR");
    const broken = await prepareS2QuestionAnswerClaim(
      question,
      "access control proxy",
      {
        id: "role@pinned",
        verify: async () => {
          throw Error("sensitive content");
        },
      },
      claim(),
    );
    expect(broken).toMatchObject({
      status: "ERROR",
      reason: "QUESTION_ROLE_OR_PROJECTION_FAILED",
    });
  });
  it("does not accept a claimed declarative proposition with no subject relation", async () => {
    const result = await prepareS2QuestionAnswerClaim(
      "Who holds the revocation key?",
      "operator",
      role(),
      claim("operator", "operator"),
    );
    expect(result.status).toBe("INSUFFICIENT");
  });
});
