import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MULTILINGUAL_NLI_MDEBERTA_DESCRIPTOR,
  LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR,
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

  it("exposes one-pass polarity diagnostics for calibration", async () => {
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.7,
      minimumPolarityMargin: 0.2,
      runtimeFactory: async () => ({
        infer: async (_premise, hypothesis) =>
          hypothesis.includes("do not define")
            ? { entailment: 0.9, neutral: 0.07, contradiction: 0.03 }
            : { entailment: 0.2, neutral: 0.1, contradiction: 0.7 },
      }),
    });

    await expect(verifier.evaluate(input)).resolves.toMatchObject({
      score: 0.9,
      oppositeScore: 0.2,
      polarityMargin: 0.7,
      direction: "NEGATIVE",
      evidenceSpan: {
        startOffset: expect.any(Number),
        endOffset: expect.any(Number),
      },
      reason: "LOCAL_MULTILINGUAL_NLI_POLARITY_CANDIDATE",
    });
  });

  it("forms Spanish yes/no polarity hypotheses without borrowing a title predicate", async () => {
    const hypotheses: string[] = [];
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.7,
      minimumPolarityMargin: 0.2,
      runtimeFactory: async () => ({
        infer: async (_premise, hypothesis) => {
          hypotheses.push(hypothesis);
          return hypothesis.startsWith("No es cierto")
            ? { entailment: 0.05, neutral: 0.15, contradiction: 0.8 }
            : { entailment: 0.9, neutral: 0.07, contradiction: 0.03 };
        },
      }),
    });

    await expect(
      verifier.verify({
        ...input,
        query: "¿Puede ALTO usar BRIO?",
        title: "Unrelated catalog title",
        passage: "ALTO puede usar BRIO para transportar eventos.",
      }),
    ).resolves.toMatchObject({
      decision: "SUPPORTS",
      reason: "LOCAL_MULTILINGUAL_NLI_POSITIVE_ANSWER_SUPPORT",
    });
    expect(hypotheses).toEqual([
      "Puede ALTO usar BRIO.",
      "No es cierto que puede ALTO usar BRIO.",
    ]);
  });

  it("keeps candidate titles out of the NLI evidence premise", async () => {
    const premises: string[] = [];
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.7,
      minimumPolarityMargin: 0.2,
      runtimeFactory: async () => ({
        infer: async (premise, hypothesis) => {
          premises.push(premise);
          return hypothesis.includes("do not define")
            ? { entailment: 0.9, neutral: 0.07, contradiction: 0.03 }
            : { entailment: 0.04, neutral: 0.08, contradiction: 0.88 };
        },
      }),
    });

    await verifier.verify({
      ...input,
      title: "Misleading title claims the patterns define architecture",
    });

    expect(premises.length).toBeGreaterThan(0);
    expect(premises).not.toContain(
      "Misleading title claims the patterns define architecture",
    );
    expect(
      premises.every(
        (premise) =>
          !premise.includes(
            "Misleading title claims the patterns define architecture",
          ),
      ),
    ).toBe(true);
    expect(premises).toContain("Strategy y Adapter son patrones locales.");
  });

  it("does not turn an open Spanish question into a yes/no hypothesis", async () => {
    const runtimeFactory = vi.fn<LocalMultilingualNliRuntimeFactory>();
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.7,
      minimumPolarityMargin: 0.2,
      runtimeFactory,
    });
    await expect(
      verifier.verify({ ...input, query: "¿Por qué ALTO usa BRIO?" }),
    ).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      reason: "LOCAL_MULTILINGUAL_NLI_QUERY_SHAPE_UNSUPPORTED",
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
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

  it("uses candidate title scope to build a generic yes/no relation hypothesis", async () => {
    const hypotheses: string[] = [];
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.6,
      minimumPolarityMargin: 0.2,
      runtimeFactory: async () => ({
        infer: async (_premise, hypothesis) => {
          hypotheses.push(hypothesis);
          return hypothesis.includes("reduces reasons to change")
            ? { entailment: 0.9, neutral: 0.06, contradiction: 0.04 }
            : { entailment: 0.05, neutral: 0.08, contradiction: 0.87 };
        },
      }),
    });

    await expect(
      verifier.verify({
        ...input,
        query: "Does a single-purpose module reduce reasons to change?",
        title: "Single-purpose modules",
        passage:
          "Un módulo con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
      }),
    ).resolves.toMatchObject({
      decision: "SUPPORTS",
      reason: "LOCAL_MULTILINGUAL_NLI_POSITIVE_ANSWER_SUPPORT",
    });
    expect(hypotheses).toContain(
      "a single-purpose module reduces reasons to change.",
    );
    expect(hypotheses).toContain(
      "a single-purpose module does not reduce reasons to change.",
    );
  });

  it("refuses generic relation parsing when the candidate title scopes the object instead of the subject", async () => {
    const runtimeFactory = vi.fn<LocalMultilingualNliRuntimeFactory>();
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.6,
      minimumPolarityMargin: 0.2,
      runtimeFactory,
    });

    await expect(
      verifier.verify({
        ...input,
        query: "Can ORCA call LUMA?",
        title: "LUMA integration",
        passage: "LUMA can call ORCA during reconciliation.",
      }),
    ).resolves.toEqual({
      decision: "INSUFFICIENT",
      reason: "LOCAL_MULTILINGUAL_NLI_QUERY_SHAPE_UNSUPPORTED",
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
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
        model: LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.model,
        revision: LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.revision,
        modelFileName: LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.modelFileName,
        dtype: LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.dtype,
        cacheDir: "/tmp/akp-model-cache",
        localFilesOnly: true,
      },
    ]);
  });

  it("passes an explicitly selected NLI descriptor to the runtime", async () => {
    const calls: unknown[] = [];
    const verifier = new LocalMultilingualNliEvidenceVerifier({
      minimumEntailmentScore: 0.7,
      minimumPolarityMargin: 0.2,
      modelDescriptor: LOCAL_MULTILINGUAL_NLI_MDEBERTA_DESCRIPTOR,
      cacheDir: "/tmp/akp-model-cache",
      localFilesOnly: true,
      runtimeFactory: async (options) => {
        calls.push(options);
        return {
          infer: async (_premise, hypothesis) =>
            hypothesis.includes("do not define")
              ? { entailment: 0.9, neutral: 0.07, contradiction: 0.03 }
              : { entailment: 0.03, neutral: 0.07, contradiction: 0.9 },
        };
      },
    });

    await verifier.verify(input);
    expect(calls).toEqual([
      {
        ...LOCAL_MULTILINGUAL_NLI_MDEBERTA_DESCRIPTOR,
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
