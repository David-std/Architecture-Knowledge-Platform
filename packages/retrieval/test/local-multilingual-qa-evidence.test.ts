import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
  LocalMultilingualQaEvidenceVerifier,
  decodeExtractiveQaLogits,
  type LocalMultilingualQaEvidencePipelineFactory,
} from "../src/local-multilingual-qa-evidence.js";

describe("local multilingual QA evidence verifier", () => {
  it("returns SUPPORTS only with a calibrated score and inspectable span", async () => {
    const factory: LocalMultilingualQaEvidencePipelineFactory =
      async () => async (_question, context) => ({
        answer: "without those drivers",
        score: 0.91,
        start: context.indexOf("without those drivers"),
        end:
          context.indexOf("without those drivers") +
          "without those drivers".length,
      });
    const verifier = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.8,
      pipelineFactory: factory,
    });
    const passage =
      "Use the mechanism for replay. without those drivers it adds overhead.";

    await expect(
      verifier.verify({
        query: "When should the mechanism be avoided?",
        candidateKey: "doc:unit",
        title: "Decision",
        passage,
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "concept",
      }),
    ).resolves.toEqual({
      decision: "SUPPORTS",
      score: 0.91,
      evidenceSpan: {
        startOffset: passage.indexOf("without those drivers"),
        endOffset:
          passage.indexOf("without those drivers") +
          "without those drivers".length,
      },
      reason: "LOCAL_MULTILINGUAL_QA_EXTRACTIVE_SUPPORT",
    });
  });

  it("keeps low-score and unmappable answers insufficient", async () => {
    const low = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.8,
      pipelineFactory: async () => async () => ({
        answer: "some phrase",
        score: 0.4,
      }),
    });
    const input = {
      query: "Why?",
      candidateKey: "doc:unit",
      title: "Decision",
      passage: "A different bounded passage.",
      unitType: "CLAIM",
      parentUnitType: null,
      documentType: "concept",
    } as const;

    await expect(low.verify(input)).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      score: 0.4,
      reason: "LOCAL_MULTILINGUAL_QA_BELOW_CALIBRATED_THRESHOLD",
    });

    const unmappable = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.8,
      pipelineFactory: async () => async () => ({
        answer: "not present",
        score: 0.95,
      }),
    });
    await expect(unmappable.verify(input)).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      score: 0.95,
      reason: "LOCAL_MULTILINGUAL_QA_ANSWER_NOT_MAPPABLE",
    });
  });

  it("loads the pinned model lazily with the configured cache policy", async () => {
    const calls: unknown[] = [];
    const factory: LocalMultilingualQaEvidencePipelineFactory = async (
      options,
    ) => {
      calls.push(options);
      return async (_question, context) => ({
        answer: context.slice(0, 7),
        score: 0.9,
        start: 0,
        end: 7,
      });
    };
    const verifier = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.75,
      cacheDir: "/tmp/akp-model-cache",
      localFilesOnly: true,
      pipelineFactory: factory,
    });

    expect(calls).toEqual([]);
    await verifier.verify({
      query: "What applies?",
      candidateKey: "doc:unit",
      title: "Rule",
      passage: "bounded evidence",
      unitType: null,
      parentUnitType: null,
      documentType: "concept",
    });
    expect(calls).toEqual([
      {
        model: LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
        revision: LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
        cacheDir: "/tmp/akp-model-cache",
        localFilesOnly: true,
      },
    ]);
  });

  it.each([0, -0.1, 1.1, Number.NaN])(
    "rejects an uncalibrated minimum support score %s",
    (minimumSupportScore) => {
      expect(
        () =>
          new LocalMultilingualQaEvidenceVerifier({
            minimumSupportScore,
            pipelineFactory: vi.fn(),
          }),
      ).toThrow(/minimumSupportScore/);
    },
  );
});

const QA_INPUT = {
  query: "Which dispatch destination applies?",
  candidateKey: "doc:unit",
  title: "Dispatch",
  passage: "Dispatch selects the healthy destination.",
  unitType: "PARAGRAPH",
  parentUnitType: null,
  documentType: "concept",
} as const;

describe("extractive QA source binding", () => {
  it("requests null-aware bounded decoding and retains no-answer outcomes", async () => {
    const reader = vi.fn(async () => [
      { answer: "healthy destination", score: 0.85 },
      { answer: "", score: 0.95 },
    ]);
    const verifier = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.8,
      pipelineFactory: async () => reader,
    });
    await expect(verifier.verify(QA_INPUT)).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      reason: "LOCAL_MULTILINGUAL_QA_NO_ANSWER",
    });
    expect(reader).toHaveBeenCalledWith(QA_INPUT.query, QA_INPUT.passage, {
      top_k: 1,
      handle_impossible_answer: true,
      max_answer_len: 15,
    });
  });

  it("rejects ambiguous repeated answers without source offsets", async () => {
    const verifier = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.8,
      pipelineFactory: async () => async () => ({
        answer: "healthy",
        score: 0.95,
      }),
    });
    await expect(
      verifier.verify({
        ...QA_INPUT,
        passage: "Alpha is healthy. Beta is not healthy.",
      }),
    ).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      reason: "LOCAL_MULTILINGUAL_QA_ANSWER_NOT_MAPPABLE",
    });
  });

  it("uses verified exact offsets to disambiguate repeated answer text", async () => {
    const passage = "Alpha is healthy. Beta is not healthy.";
    const start = passage.lastIndexOf("healthy");
    const verifier = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.8,
      pipelineFactory: async () => async () => ({
        answer: "healthy",
        score: 0.95,
        start,
        end: start + "healthy".length,
      }),
    });
    await expect(
      verifier.verify({ ...QA_INPUT, passage }),
    ).resolves.toMatchObject({
      decision: "SUPPORTS",
      evidenceSpan: { startOffset: start, endOffset: start + "healthy".length },
    });
  });

  it("does not fabricate UTF-16 offsets by lowercasing Unicode text", async () => {
    const verifier = new LocalMultilingualQaEvidenceVerifier({
      minimumSupportScore: 0.8,
      pipelineFactory: async () => async () => ({
        answer: "HEALTHY",
        score: 0.95,
      }),
    });
    await expect(
      verifier.verify({ ...QA_INPUT, passage: "İ dispatch: healthy." }),
    ).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      reason: "LOCAL_MULTILINGUAL_QA_ANSWER_NOT_MAPPABLE",
    });
  });

  it.each([-0.1, 1.01, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid model probabilities %s",
    async (score) => {
      const verifier = new LocalMultilingualQaEvidenceVerifier({
        minimumSupportScore: 0.8,
        pipelineFactory: async () => async () => ({ answer: "healthy", score }),
      });
      await expect(verifier.verify(QA_INPUT)).resolves.toMatchObject({
        decision: "INSUFFICIENT",
      });
    },
  );
});

const LOGITS_INPUT = {
  inputIds: [0, 10, 2, 2, 22, 23, 2, 1],
  attentionMask: [1, 1, 1, 1, 1, 1, 1, 0],
  startLogits: [-10, -10, -10, -10, 10, -10, -10, -10],
  endLogits: [-10, -10, -10, -10, 10, -10, -10, -10],
  separatorTokenId: 2,
  classificationTokenId: 0,
  specialTokenIds: [0, 1, 2],
  maxAnswerTokens: 15,
};

describe("null-aware SQuAD2 span decoding", () => {
  it("lets CLS win over the highest nonempty span", () => {
    const result = decodeExtractiveQaLogits({
      ...LOGITS_INPUT,
      startLogits: [11, -10, -10, -10, 10, -10, -10, -10],
      endLogits: [11, -10, -10, -10, 10, -10, -10, -10],
    });
    expect(result).toMatchObject({ startToken: null, endToken: null });
    expect(result.score).toBeCloseTo(0.534446645, 6);
  });

  it("returns a valid context span when it beats the null answer", () => {
    const result = decodeExtractiveQaLogits(LOGITS_INPUT);
    expect(result).toMatchObject({ startToken: 4, endToken: 4 });
    expect(result.score).toBeGreaterThan(0.99);
  });

  it("masks question, special and padded logits before normalization", () => {
    const result = decodeExtractiveQaLogits({
      ...LOGITS_INPUT,
      startLogits: [-10, 100, 100, 100, 10, -10, 100, 100],
      endLogits: [-10, 100, 100, 100, 10, -10, 100, 100],
    });
    expect(result).toMatchObject({ startToken: 4, endToken: 4 });
    expect(result.score).toBeGreaterThan(0.99);
  });

  it("retains abstention when all valid spans tie with CLS", () => {
    expect(
      decodeExtractiveQaLogits({
        ...LOGITS_INPUT,
        startLogits: Array(8).fill(0),
        endLogits: Array(8).fill(0),
      }),
    ).toMatchObject({ startToken: null, endToken: null });
  });

  it("bounds answer length and cannot cross an internal special token", () => {
    const bounded = decodeExtractiveQaLogits({
      ...LOGITS_INPUT,
      endLogits: [-10, -10, -10, -10, -10, 10, -10, -10],
      maxAnswerTokens: 1,
    });
    expect(bounded.startToken).toBe(bounded.endToken);
    expect(
      decodeExtractiveQaLogits({
        ...LOGITS_INPUT,
        inputIds: [0, 10, 2, 2, 22, 2, 23, 1],
        endLogits: [-10, -10, -10, -10, -10, -10, 10, -10],
      }),
    ).not.toMatchObject({ startToken: 4, endToken: 6 });
  });

  it("rejects malformed shapes and nonfinite logits", () => {
    expect(() =>
      decodeExtractiveQaLogits({ ...LOGITS_INPUT, attentionMask: [1] }),
    ).toThrow(/LOGITS_INVALID/);
    expect(() =>
      decodeExtractiveQaLogits({
        ...LOGITS_INPUT,
        startLogits: Array(8).fill(Number.NaN),
      }),
    ).toThrow(/LOGITS_INVALID/);
    expect(() =>
      decodeExtractiveQaLogits({ ...LOGITS_INPUT, maxAnswerTokens: 0 }),
    ).toThrow(/LOGITS_INVALID/);
  });
});
