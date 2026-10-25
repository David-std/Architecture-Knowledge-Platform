import { describe, it, expect, vi } from "vitest";
import {
  prepareS2QuestionAnswerClaim,
  createS2ImmutableAnswerSlotProjector,
} from "../src/s2-question-answer-claim.js";
const question = "When did the representatives sign the agreement?";
const answer = "On 28 February 2008";
const before = {
  id: "qa-role@same-question",
  verify: async () => ({
    decision: "MATCH" as const,
    reason: "DATE_ANSWER_MATCHES_QUESTION_TYPE",
  }),
};
const projector = (template: string) =>
  createS2ImmutableAnswerSlotProjector({
    id: "writer-template@development",
    projectTemplate: async () => ({
      template,
      reason: "TEMPLATE_PROPOSED",
    }),
  });
const post = (decision: "MATCH" | "MISMATCH" | "UNCERTAIN") => ({
  id: "projected-role@new-observation",
  verify: vi.fn(async () => ({
    decision,
    reason: "QUESTION_TO_ASSERTION_ROLE_ASSESSED",
  })),
});
describe("post-projection role guard detects failures invisible to original QA-only role check", () => {
  it("exposes inverted subject/date in a claim even when QA role initially matches and slot is immutable", async () => {
    const bad = projector("__AKP_ANSWER_SLOT__ signed the agreement.");
    const result = await prepareS2QuestionAnswerClaim(
      question,
      answer,
      before,
      bad,
      post("MISMATCH"),
    );
    expect(result).toMatchObject({
      status: "ROLE_DISPUTED_CLAIM_CANDIDATE",
      claimText: "On 28 February 2008 signed the agreement.",
      roleDecision: "MATCH",
      projectedClaimRoleDecision: "MISMATCH",
      reason: "PROJECTED_OR_ANSWER_ROLE_DISPUTED_NOT_A_SEMANTIC_VETO",
      semanticsVerified: false,
      sourceEntailmentVerified: false,
      productionAdmission: false,
    });
  });
  it("separate positive role proposal still is not semantic approval or citation support", async () => {
    const good = projector(
      "The representatives signed the agreement __AKP_ANSWER_SLOT__.",
    );
    const result = await prepareS2QuestionAnswerClaim(
      question,
      answer,
      before,
      good,
      post("MATCH"),
    );
    expect(result).toMatchObject({
      status: "CLAIM_CANDIDATE",
      projectedClaimRoleDecision: "MATCH",
      projectedRoleIndependenceVerified: false,
      semanticsVerified: false,
      releaseGateAccepted: false,
    });
  });
  it("uncertain role after projection must not become verified by a prior QA-only MATCH", async () => {
    const x = await prepareS2QuestionAnswerClaim(
      question,
      answer,
      before,
      projector(
        "The representatives signed the agreement __AKP_ANSWER_SLOT__.",
      ),
      post("UNCERTAIN"),
    );
    expect(x).toMatchObject({
      status: "ROLE_DISPUTED_CLAIM_CANDIDATE",
      projectedClaimRoleDecision: "UNCERTAIN",
    });
  });
  it("invalid or throwing projected-role models fail closed and retain source-free original claim for inspection", async () => {
    for (const check of [
      {
        id: "bad@v1",
        verify: async () => ({ decision: "SUPPORTS", reason: "GOOD" }),
      },
      {
        id: "bad@v1",
        verify: async () => {
          throw Error("worker unavailable");
        },
      },
      {
        id: "bad@v1",
        verify: async () => ({ decision: "MATCH", reason: "bad-reason" }),
      },
      {
        id: "bad@v1",
        verify: async () => ({ decision: "MATCH", reason: "GOOD", extra: "x" }),
      },
    ]) {
      const x = await prepareS2QuestionAnswerClaim(
        question,
        answer,
        before,
        projector(
          "The representatives signed the agreement __AKP_ANSWER_SLOT__.",
        ),
        check as never,
      );
      expect(x).toMatchObject({
        status: "ERROR",
        sourceEntailmentVerified: false,
        releaseGateAccepted: false,
        productionAdmission: false,
      });
      expect(x.claimText).toContain(answer);
    }
  });
  it("rejects same-identity or badly identified checks instead of claiming independence", async () => {
    for (const id of [before.id, "writer-template@development", "invalid"]) {
      const x = await prepareS2QuestionAnswerClaim(
        question,
        answer,
        before,
        projector(
          "The representatives signed the agreement __AKP_ANSWER_SLOT__.",
        ),
        {
          id,
          verify: async () => ({ decision: "MATCH", reason: "CHECK_OK" }),
        },
      );
      expect(x).toMatchObject({
        status: "REJECTED",
        productionAdmission: false,
      });
    }
  });
  it("old four-argument calls preserve their historical status and reason", async () => {
    const x = await prepareS2QuestionAnswerClaim(
      question,
      answer,
      before,
      projector("__AKP_ANSWER_SLOT__ signed the agreement."),
    );
    expect(x).toMatchObject({
      status: "CLAIM_CANDIDATE",
      reason: "UNVERIFIED_FULL_QUESTION_CLAIM",
      projectedClaimRoleDecision: null,
      projectedClaimRoleProbeId: null,
      productionAdmission: false,
    });
  });
});
