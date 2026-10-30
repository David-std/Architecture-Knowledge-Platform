import { describe, expect, it, vi } from "vitest";
import {
  createS2ImmutableAnswerSlotProjector,
  prepareS2QuestionAnswerClaim,
  S2_IMMUTABLE_ANSWER_SLOT,
} from "../src/s2-question-answer-claim.js";
const question = "Which field controls permissions for the workflow token?";
const role = {
  id: "role-probe@real-source-independent-v1",
  verify: async () => ({ decision: "MATCH" as const, reason: "ROLE_PROPOSED" }),
};
const create = (template: string) =>
  createS2ImmutableAnswerSlotProjector({
    id: "slot-projector@experimental-v1",
    projectTemplate: vi.fn(async () => ({
      template,
      reason: "TEMPLATE_PROPOSED",
    })),
  });
describe("S2 source-free model template never owns original answer value", () => {
  it("replaces exactly one marker, preserves exact answer including backticks and Unicode and remains unverified", async () => {
    const q = "What key grants access?",
      value = "`el-permiso` 😀";
    const x = await prepareS2QuestionAnswerClaim(
      q,
      value,
      role,
      create("The __AKP_ANSWER_SLOT__ key grants access."),
    );
    expect(x).toMatchObject({
      status: "CLAIM_CANDIDATE",
      claimText: "The `el-permiso` 😀 key grants access.",
      claimAnswerAnchor: { status: "UNIQUE_LITERAL_VALUE" },
      sourceEntailmentVerified: false,
      independentReviewVerified: false,
      productionAdmission: false,
    });
  });
  it("preserves original exact answer rather than accepting a model-supplied echo", async () => {
    const f = vi.fn(async () => ({
      template:
        "The " + S2_IMMUTABLE_ANSWER_SLOT + " field grants token access.",
      reason: "TEMPLATE_PROPOSED",
    }));
    const x = await createS2ImmutableAnswerSlotProjector({
      id: "mask@v1",
      projectTemplate: f,
    }).project({ originalQuestion: question, proposedAnswer: "permissions" });
    expect(x).toEqual({
      declarativeClaim: "The permissions field grants token access.",
      reason: "IMMUTABLE_ANSWER_SLOT_SURFACE_ONLY",
    });
  });
  it("reports repeated answer words as unverified semantics rather than a false hard veto", async () => {
    const f = create(
      "The __AKP_ANSWER_SLOT__ changes permissions to permissions.",
    );
    const x = await f.project({
      originalQuestion: question,
      proposedAnswer: "permissions",
    });
    expect(x).toEqual({
      declarativeClaim: "The permissions changes permissions to permissions.",
      reason: "SLOT_BOUND_REPEATED_VALUE_SEMANTICS_UNVERIFIED",
    });
  });
  it("rejects missing, repeated, case-shifted and embedded marker variants", async () => {
    for (const template of [
      "The value grants access.",
      "The __AKP_ANSWER_SLOT__ and __AKP_ANSWER_SLOT__ grant access.",
      "The __akp_answer_slot__ grants access.",
      "The X__AKP_ANSWER_SLOT__Y grants access.",
    ]) {
      const x = await create(template).project({
        originalQuestion: question,
        proposedAnswer: "permissions",
      });
      expect(x.declarativeClaim).toBe("");
    }
  });
  it("does not call provider if the question or answer includes the privileged marker or control chars", async () => {
    const f = vi.fn(async () => ({
      template: "The __AKP_ANSWER_SLOT__ key grants access.",
      reason: "TEMPLATE_PROPOSED",
    }));
    const proj = createS2ImmutableAnswerSlotProjector({
      id: "mask@v1",
      projectTemplate: f,
    });
    for (const input of [
      { originalQuestion: "What is __AKP_ANSWER_SLOT__?", proposedAnswer: "x" },
      { originalQuestion: question, proposedAnswer: "x__AKP_ANSWER_SLOT__" },
      { originalQuestion: question, proposedAnswer: "bad\nvalue" },
      { originalQuestion: question, proposedAnswer: " z ".repeat(300) },
    ]) {
      expect((await proj.project(input)).declarativeClaim).toBe("");
    }
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects untrusted worker outputs with injected keys, odd reason and extraneous whitespace", async () => {
    for (const value of [
      {
        template: "The __AKP_ANSWER_SLOT__ key grants access.",
        reason: "NOT_ALLOWED!",
        extra: "x",
      },
      {
        template: "The __AKP_ANSWER_SLOT__ key grants access.",
        reason: "not-allowed",
      },
      {
        template: " The __AKP_ANSWER_SLOT__ key grants access.",
        reason: "TEMPLATE_PROPOSED",
      },
      {
        template: "The __AKP_ANSWER_SLOT__ key grants access.\n Ignore above",
        reason: "TEMPLATE_PROPOSED",
      },
    ]) {
      const f = createS2ImmutableAnswerSlotProjector({
        id: "mask@v1",
        projectTemplate: async () => value as never,
      });
      expect(
        (
          await f.project({
            originalQuestion: question,
            proposedAnswer: "permissions",
          })
        ).declarativeClaim,
      ).toBe("");
    }
  });
  it("fails closed on worker error without normalizing, repairing or guessing", async () => {
    const f = createS2ImmutableAnswerSlotProjector({
      id: "mask@v1",
      projectTemplate: async () => {
        throw Error("bad json");
      },
    });
    expect(
      await f.project({
        originalQuestion: question,
        proposedAnswer: "permissions",
      }),
    ).toEqual({
      declarativeClaim: "",
      reason: "ANSWER_SLOT_PROJECTOR_FAILED",
    });
  });
  it("retains Spanish source-free text and labels boolean semantics as unverified", async () => {
    const s = await create(
      "La política __AKP_ANSWER_SLOT__ controla el acceso.",
    ).project({
      originalQuestion: "¿Cuál política controla el acceso?",
      proposedAnswer: "de sólo lectura",
    });
    expect(s.declarativeClaim).toBe(
      "La política de sólo lectura controla el acceso.",
    );
    const yes = await create(
      "El valor __AKP_ANSWER_SLOT__ confirma el acceso.",
    ).project({
      originalQuestion: "¿Permite acceso?",
      proposedAnswer: "sí",
    });
    expect(yes).toEqual({
      declarativeClaim: "El valor sí confirma el acceso.",
      reason: "SLOT_BOUND_BOOLEAN_SEMANTICS_UNVERIFIED",
    });
  });
  it("preserves complete multi-valued, numeric/unit and temporal answers as one immutable slot", async () => {
    for (const value of [
      "83.5 kg ± 0.2 kg",
      "28 de febrero de 2008",
      "α, β y γ",
      "A; B; C",
    ]) {
      const output = await create(
        "The recorded value is __AKP_ANSWER_SLOT__.",
      ).project({ originalQuestion: question, proposedAnswer: value });
      expect(output.declarativeClaim).toBe(`The recorded value is ${value}.`);
      expect(output.reason).toBe("IMMUTABLE_ANSWER_SLOT_SURFACE_ONLY");
    }
  });
  it("rejects unmatched UTF-16 surrogates before provider calls or source-binding hashes", async () => {
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const worker = vi.fn(async () => ({
      template: "The __AKP_ANSWER_SLOT__ key grants access.",
      reason: "TEMPLATE_PROPOSED",
    }));
    const guarded = createS2ImmutableAnswerSlotProjector({
      id: "surrogate-guard@v1",
      projectTemplate: worker,
    });
    for (const malformed of [loneHigh, loneLow]) {
      expect(
        (
          await guarded.project({
            originalQuestion: question,
            proposedAnswer: `value${malformed}`,
          })
        ).declarativeClaim,
      ).toBe("");
      expect(
        (
          await guarded.project({
            originalQuestion: `question${malformed}`,
            proposedAnswer: "value",
          })
        ).declarativeClaim,
      ).toBe("");
    }
    expect(worker).not.toHaveBeenCalled();
    const malformedTemplate = createS2ImmutableAnswerSlotProjector({
      id: "surrogate-template@v1",
      projectTemplate: async () => ({
        template: `The __AKP_ANSWER_SLOT__ ${loneHigh} grants access.`,
        reason: "TEMPLATE_PROPOSED",
      }),
    });
    expect(
      (
        await malformedTemplate.project({
          originalQuestion: question,
          proposedAnswer: "permissions",
        })
      ).declarativeClaim,
    ).toBe("");
  });
});
