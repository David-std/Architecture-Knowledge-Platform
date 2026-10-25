import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  freezeS2FrozenReaderChoicePlan,
  assessS2FrozenReaderChoice,
  type S2FrozenReaderChoiceInput,
} from "../src/s2-frozen-reader-source-bridge.js";
import type {
  S2SemanticEvidenceConfig,
  S2SemanticProbe,
} from "../src/s2-semantic-evidence.js";

const source =
  "The TypeScript compiler uses a type annotation to describe the array. " +
  "The array can contain strings, but a number[] annotation describes numbers.";
const quote =
  "The TypeScript compiler uses a type annotation to describe the array.";
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const input = (): S2FrozenReaderChoiceInput => ({
  originalQuestion: "¿Qué describe la anotación de tipos?",
  proposedClaim: "The annotation describes an array.",
  exactSourceQuote: quote,
  authorizedOriginal: {
    assignedSourceId: "source:typescript",
    sourceSha256: sha(source),
    exactUtf8Bytes: Buffer.from(source, "utf8"),
    bodyStartUtf16: 0,
    bodyEndUtf16: source.length,
  },
});
const probes = (claimAnswer: "SUPPORTS" | "INSUFFICIENT" = "SUPPORTS") => {
  const question = vi.fn(async (x: { exactQuote: string }) => ({
    decision: "SUPPORTS" as const,
    reason: "QUESTION_ROLE_PROPOSED",
    evidenceSpan: { startUtf16: 0, endUtf16: x.exactQuote.length },
  }));
  const claim = vi.fn(async (x: { exactQuote: string }) =>
    claimAnswer === "SUPPORTS"
      ? {
          decision: "SUPPORTS" as const,
          reason: "CLAIM_ENTAILMENT_PROPOSED",
          evidenceSpan: { startUtf16: 0, endUtf16: x.exactQuote.length },
        }
      : {
          decision: "INSUFFICIENT" as const,
          reason: "MODALITY_NOT_ESTABLISHED",
        },
  );
  const config: S2SemanticEvidenceConfig = {
    questionRelevanceProbe: {
      id: "question-role@mock-dev",
      verify: question,
    } as S2SemanticProbe,
    claimEntailmentProbe: {
      id: "claim-role@mock-dev",
      verify: claim,
    } as S2SemanticProbe,
  };
  return { config, question, claim };
};
const proposal = () => ({
  questionToken: "SUPPORTS@Q1",
  claimToken: "SUPPORTS@Q1",
});

describe("S2 source-frozen reader bridge: source-bound semantics only", () => {
  it("freezes the exact original, precommits query and claim, and permits candidate-only support", async () => {
    const original = input();
    const frozen = freezeS2FrozenReaderChoicePlan(original);
    expect(frozen.sourceSha256).toBe(sha(source));
    expect(frozen.originalQuestionSha256).toBe(sha(original.originalQuestion));
    expect(frozen.proposedClaimSha256).toBe(sha(original.proposedClaim));
    expect(frozen.tokenSchema.properties.questionToken.enum).toContain(
      "SUPPORTS@Q1",
    );
    const judge = probes();
    const result = await assessS2FrozenReaderChoice(
      original,
      frozen,
      proposal(),
      judge.config,
    );
    expect(result).toMatchObject({
      status: "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY",
      originalQuoteStartUtf16: 0,
      originalQuoteEndUtf16: quote.length,
      assessment: {
        status: "SUPPORTED_CANDIDATE",
        attribution: {
          status: "VERBATIM_UNIQUE_SOURCE_BOUND",
          sourceSha256: sha(source),
        },
        productionAdmission: false,
      },
      semanticRelationIndependentlyVerified: false,
      sourceAuthorizationIndependentlyVerified: false,
      releaseGateAccepted: false,
      productionAdmission: false,
    });
    expect(judge.question).toHaveBeenCalledOnce();
    expect(judge.claim).toHaveBeenCalledOnce();
  });

  it("never turns a model's source ID into source ownership or repairs provenance", async () => {
    const original = input();
    const freeze = freezeS2FrozenReaderChoicePlan(original);
    const judge = probes();
    const cases = [
      {
        ...original,
        originalQuestion: original.originalQuestion + " incorrect",
      },
      { ...original, proposedClaim: "All arrays must contain strings." },
      { ...original, exactSourceQuote: quote + " invented" },
      {
        ...original,
        authorizedOriginal: {
          ...original.authorizedOriginal,
          sourceSha256: "0".repeat(64),
        },
      },
      {
        ...original,
        authorizedOriginal: {
          ...original.authorizedOriginal,
          assignedSourceId: "another-vault:source",
        },
      },
    ];
    for (const altered of cases) {
      const result = await assessS2FrozenReaderChoice(
        altered,
        freeze,
        proposal(),
        judge.config,
      );
      expect(result.status).toBe("HELD");
    }
    expect(judge.question).not.toHaveBeenCalled();
    expect(judge.claim).not.toHaveBeenCalled();
    expect(() =>
      freezeS2FrozenReaderChoicePlan({
        ...original,
        exactSourceQuote: "The document approves itself",
      }),
    ).toThrow("S2_FROZEN_READER_ORIGINAL_SOURCE_NOT_BOUND");
  });

  it("rejects forged tokens, mixed abstention and arbitrary model-provided quote text", async () => {
    const original = input();
    const frozen = freezeS2FrozenReaderChoicePlan(original);
    const judge = probes();
    for (const value of [
      { questionToken: "SUPPORTS@Q9", claimToken: "SUPPORTS@Q1" },
      { questionToken: "SUPPORTS@Q1", claimToken: "INSUFFICIENT@NONE" },
      { questionToken: "INSUFFICIENT@Q1", claimToken: "SUPPORTS@Q1" },
      {
        questionToken: "SUPPORTS@Q1",
        claimToken: "SUPPORTS@Q1",
        quote: "invented source text",
      },
      {
        questionToken: "SUPPORTS@Q1",
        claimToken: "SUPPORTS@Q1",
        permissions: ["knowledge:review"],
      },
    ]) {
      const result = await assessS2FrozenReaderChoice(
        original,
        frozen,
        value,
        judge.config,
      );
      expect(result.status).toBe("HELD");
      expect(result.productionAdmission).toBe(false);
    }
    expect(judge.question).not.toHaveBeenCalled();
    expect(judge.claim).not.toHaveBeenCalled();
  });

  it("never treats a valid citation and a positive question verdict as claim entailment", async () => {
    const original = input();
    const frozen = freezeS2FrozenReaderChoicePlan(original);
    const judge = probes("INSUFFICIENT");
    const result = await assessS2FrozenReaderChoice(
      original,
      frozen,
      proposal(),
      judge.config,
    );
    expect(result).toMatchObject({
      status: "HELD",
      reason: "SEMANTIC_OR_F3_PROOF_NOT_ESTABLISHED",
      assessment: {
        status: "INSUFFICIENT",
        reason: "CLAIM_ENTAILMENT_INSUFFICIENT",
        productionAdmission: false,
      },
    });
    expect(judge.question).toHaveBeenCalledOnce();
    expect(judge.claim).toHaveBeenCalledOnce();
  });

  it("rejects tampering with the frozen schema and exact span even when token shape is legal", async () => {
    const original = input();
    const frozen = freezeS2FrozenReaderChoicePlan(original);
    const changed = {
      ...frozen,
      sourceStartUtf16: 1,
      tokenSchema: {
        ...frozen.tokenSchema,
        properties: {
          ...frozen.tokenSchema.properties,
          claimToken: { type: "string" as const, enum: ["SUPPORTS@Q1"] },
        },
      },
    };
    const result = await assessS2FrozenReaderChoice(
      original,
      changed as typeof frozen,
      proposal(),
      probes().config,
    );
    expect(result.status).toBe("HELD");
    expect(result.reason).toBe("SOURCE_QUESTION_CLAIM_OR_FROZEN_PLAN_DRIFT");
  });

  it("rejects different question and claim spans from the same genuine long source", async () => {
    const body =
      "First, the customer status is only provisional. " +
      "The configuration must not be published without approval. ".repeat(10) +
      "Finally, an approved review is recorded in the knowledge vault.";
    const long: S2FrozenReaderChoiceInput = {
      originalQuestion: "What is required before publication?",
      proposedClaim: "Publication requires an approved review.",
      exactSourceQuote: body,
      authorizedOriginal: {
        assignedSourceId: "source:publication",
        sourceSha256: sha(body),
        exactUtf8Bytes: Buffer.from(body),
        bodyStartUtf16: 0,
        bodyEndUtf16: body.length,
      },
    };
    const frozen = freezeS2FrozenReaderChoicePlan(long, 256);
    expect(frozen.frozen.options.length).toBeGreaterThan(1);
    expect(frozen.tokenSchema.properties.questionToken.enum).toContain(
      "SUPPORTS@Q2",
    );
    const judge = probes();
    const answer = await assessS2FrozenReaderChoice(
      long,
      frozen,
      { questionToken: "SUPPORTS@Q1", claimToken: "SUPPORTS@Q2" },
      judge.config,
    );
    expect(answer).toMatchObject({
      status: "HELD",
      reason: "QUESTION_AND_CLAIM_SELECTED_DIFFERENT_SPANS",
      productionAdmission: false,
    });
    expect(judge.question).not.toHaveBeenCalled();
    expect(judge.claim).not.toHaveBeenCalled();
  });

  it("rejects source Unicode or boundary drift and duplicates without a fuzzy repair", () => {
    const original = input();
    const duplicate = source + " " + quote;
    expect(() =>
      freezeS2FrozenReaderChoicePlan({
        ...original,
        authorizedOriginal: {
          ...original.authorizedOriginal,
          exactUtf8Bytes: Buffer.from(duplicate),
          sourceSha256: sha(duplicate),
          bodyEndUtf16: duplicate.length,
        },
      }),
    ).toThrow("S2_FROZEN_READER_ORIGINAL_SOURCE_NOT_BOUND");
  });
});
