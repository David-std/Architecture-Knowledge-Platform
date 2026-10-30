import { describe, expect, it } from "vitest";
import { shadowEvidenceMetrics } from "../scripts/shadow-evidence-metrics.js";

type Observation = Parameters<typeof shadowEvidenceMetrics>[0][number];

function candidate(
  label: string,
  overrides: Partial<Observation["candidates"][number]> = {},
): Observation["candidates"][number] {
  return {
    label,
    score: 0.9,
    directionCompatible: true,
    spanCorrect: true,
    polarityMargin: 0.4,
    ...overrides,
  };
}

describe("shadow evidence metrics", () => {
  it("does not certify precision or span accuracy on an empty sample", () => {
    const result = shadowEvidenceMetrics([], 0.8);
    expect(result).toMatchObject({
      selectedCandidates: 0,
      supportSelectionPrecision: null,
      spanAccuracy: null,
      spanAnnotationCoverage: null,
      falseAbstentionRate: null,
      falseAcceptanceRate: null,
    });
  });

  it("keeps abstention visible when a positive has no admitted source", () => {
    const result = shadowEvidenceMetrics(
      [
        {
          goldLabels: ["gold"],
          candidates: [candidate("gold", { score: 0.4 })],
        },
      ],
      0.8,
    );
    expect(result).toMatchObject({
      falseAbstentions: 1,
      falseAbstentionRate: 1,
      supportSelectionPrecision: null,
      spanAccuracy: null,
    });
  });

  it("does not turn absent span annotations into correct spans", () => {
    const result = shadowEvidenceMetrics(
      [
        {
          goldLabels: ["gold"],
          candidates: [
            candidate("gold", { spanCorrect: null, polarityMargin: undefined }),
          ],
        },
      ],
      0.8,
    );
    expect(result).toMatchObject({
      supportSelectionPrecision: 1,
      spanEvaluatedCandidates: 0,
      spanAnnotationCoverage: 0,
      spanAccuracy: null,
    });
  });

  it("exposes partial span coverage instead of certifying the whole selection", () => {
    const result = shadowEvidenceMetrics(
      [
        {
          goldLabels: ["first", "second"],
          candidates: [
            candidate("first"),
            candidate("second", { spanCorrect: null }),
          ],
        },
      ],
      0.8,
    );
    expect(result).toMatchObject({
      selectedGoldCandidates: 2,
      spanEvaluatedCandidates: 1,
      spanCorrectCandidates: 1,
      spanAnnotationCoverage: 0.5,
      spanAccuracy: null,
    });
  });

  it("counts a wrong source even in a case that also accepts its gold source", () => {
    const result = shadowEvidenceMetrics(
      [
        {
          goldLabels: ["gold"],
          candidates: [candidate("gold"), candidate("distractor")],
        },
      ],
      0.8,
    );
    expect(result).toMatchObject({
      falseAcceptances: 0,
      wrongSelections: 1,
      selectedCandidates: 2,
      supportSelectionPrecision: 0.5,
      spanAccuracy: 1,
    });
  });

  it("separates source selection from exact-span correctness", () => {
    const result = shadowEvidenceMetrics(
      [
        {
          goldLabels: ["gold"],
          candidates: [candidate("gold", { spanCorrect: false })],
        },
      ],
      0.8,
    );
    expect(result).toMatchObject({
      supportSelectionPrecision: 1,
      spanAnnotationCoverage: 1,
      spanAccuracy: 0,
    });
  });

  it("applies direction and polarity admission before counting negative acceptance", () => {
    const result = shadowEvidenceMetrics(
      [
        {
          goldLabels: [],
          candidates: [
            candidate("reverse", { directionCompatible: false }),
            candidate("weak-polarity", { polarityMargin: 0.1 }),
            candidate("accepted"),
          ],
        },
      ],
      0.8,
      0.3,
    );
    expect(result).toMatchObject({
      negativeCases: 1,
      falseAcceptances: 1,
      selectedCandidates: 1,
      wrongSelections: 1,
      supportSelectionPrecision: 0,
      spanAccuracy: null,
    });
  });
});
