import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
  LocalMultilingualQaEvidenceVerifier,
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
