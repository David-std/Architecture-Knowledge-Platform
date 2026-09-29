import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MULTILINGUAL_NLI_MODEL,
  LOCAL_MULTILINGUAL_NLI_REVISION,
  LocalMultilingualNliEvidenceVerifier,
  type LocalMultilingualNliRuntimeFactory,
} from "../src/local-multilingual-nli-evidence.js";

const input = {
  query:
    "Do Strategy and Adapter patterns define the overall system architecture?",
  candidateKey: "doc:unit",
  title: "Local patterns and architecture",
  passage:
    "Strategy y Adapter son patrones locales. No determinan el conjunto de módulos, límites ni la dirección global de dependencias del sistema.",
  unitType: "CLAIM",
  parentUnitType: null,
  documentType: "concept",
} as const;

describe("local multilingual NLI evidence verifier", () => {
  it("accepts a clearly entailed negative answer and returns the bounded span", async () => {
    const runtimeFactory: LocalMultilingualNliRuntimeFactory = async () => ({
      infer: async (_premise, hypothesis) =>
        hypothesis.includes("do not define")
          ? { entailment: 0.9, neutral: 0.07, contradiction: 0.03 }
          : { entailment: 0.04, neutral: 0.08, contradiction: 0.88 },
    });
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.7,
      minimumPolarityMargin: 0.2,
      runtimeFactory,
    });

    await expect(verifier.verify(input)).resolves.toMatchObject({
      decision: "SUPPORTS",
      score: 0.9,
      reason: "LOCAL_MULTILINGUAL_NLI_NEGATIVE_ANSWER_SUPPORT",
      evidenceSpan: {
        startOffset: expect.any(Number),
        endOffset: expect.any(Number),
      },
    });
  });

  it("rejects a lexical distractor when both polarities remain neutral", async () => {
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.6,
      minimumPolarityMargin: 0.2,
      runtimeFactory: async () => ({
        infer: async () => ({
          entailment: 0.12,
          neutral: 0.8,
          contradiction: 0.08,
        }),
      }),
    });

    await expect(
      verifier.verify({
        ...input,
        passage:
          "The persistence adapter defines a uniqueness strategy for generated record keys.",
      }),
    ).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      reason: "LOCAL_MULTILINGUAL_NLI_NO_ENTAILED_POLARITY",
    });
  });

  it("refuses query shapes for which it cannot build a faithful hypothesis", async () => {
    const runtimeFactory = vi.fn<LocalMultilingualNliRuntimeFactory>();
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.6,
      minimumPolarityMargin: 0.2,
      runtimeFactory,
    });

    await expect(
      verifier.verify({
        ...input,
        query: "Why do dependencies point inward toward domain policies?",
      }),
    ).resolves.toEqual({
      decision: "INSUFFICIENT",
      reason: "LOCAL_MULTILINGUAL_NLI_QUERY_SHAPE_UNSUPPORTED",
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("requires an unambiguous polarity even when entailment is high", async () => {
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.6,
      minimumPolarityMargin: 0.2,
      runtimeFactory: async () => ({
        infer: async () => ({
          entailment: 0.75,
          neutral: 0.15,
          contradiction: 0.1,
        }),
      }),
    });

    await expect(verifier.verify(input)).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      score: 0.75,
      reason: "LOCAL_MULTILINGUAL_NLI_POLARITY_AMBIGUOUS",
    });
  });

  it("loads the pinned runtime lazily", async () => {
    const calls: unknown[] = [];
    const runtimeFactory: LocalMultilingualNliRuntimeFactory = async (
      options,
    ) => {
      calls.push(options);
      return {
        infer: async (_premise, hypothesis) =>
          hypothesis.includes("do not define")
            ? { entailment: 0.85, neutral: 0.1, contradiction: 0.05 }
            : { entailment: 0.05, neutral: 0.1, contradiction: 0.85 },
      };
    };
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.7,
      minimumPolarityMargin: 0.2,
      cacheDir: "/tmp/akp-model-cache",
      localFilesOnly: true,
      runtimeFactory,
    });
    expect(calls).toEqual([]);
    await verifier.verify(input);
    expect(calls).toEqual([
      {
        model: LOCAL_MULTILINGUAL_NLI_MODEL,
        revision: LOCAL_MULTILINGUAL_NLI_REVISION,
        cacheDir: "/tmp/akp-model-cache",
        localFilesOnly: true,
      },
    ]);
  });

  it.each([
    { minimumEntailmentScore: -0.1, minimumPolarityMargin: 0.2 },
    { minimumEntailmentScore: 1.1, minimumPolarityMargin: 0.2 },
    { minimumEntailmentScore: 0.7, minimumPolarityMargin: -0.1 },
    { minimumEntailmentScore: 0.7, minimumPolarityMargin: 1.1 },
  ])("rejects invalid calibration %o", (options) => {
    expect(
      () =>
        new LocalMultilingualNliEvidenceVerifier({
          ...options,
          runtimeFactory: vi.fn(),
        }),
    ).toThrow(/local multilingual NLI/);
  });
});
