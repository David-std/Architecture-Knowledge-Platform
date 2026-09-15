import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "context-correctness-regressions.json",
);

interface RegressionCase {
  id: string;
  kind: string;
  denseScores?: Record<string, number>;
  expectations: Record<string, unknown>;
}

interface RegressionPack {
  schemaVersion: number;
  evidenceLevel: string;
  productionDefaultsChanged: boolean;
  cases: RegressionCase[];
}

async function loadRegressionPack(): Promise<RegressionPack> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as RegressionPack;
}

describe("context correctness regression contract", () => {
  it("pins required P0 correctness regressions", async () => {
    const pack = await loadRegressionPack();
    expect(pack.schemaVersion).toBe(1);
    expect(pack.productionDefaultsChanged).toBe(false);
    expect(pack.evidenceLevel).toBe("P0_REGRESSION_SPEC");

    const temporal = pack.cases.find(
      (item) => item.kind === "TEMPORAL_TRUTH_CONTRADICTION",
    );
    expect(temporal).toBeDefined();

    const scores = temporal?.denseScores;
    const oldScore = scores?.["security-guide-v1"] ?? 0;
    const currentScore = scores?.["security-guide-v3"] ?? Infinity;
    expect(oldScore).toBeGreaterThan(currentScore);
    expect(Math.abs(oldScore - currentScore)).toBeLessThan(0.01);

    const truth = temporal?.expectations;
    expect(truth?.current).toEqual(["security-guide-v3"]);
    expect(truth?.asOfBeforeChange).toEqual(["security-guide-v1"]);
    expect(truth?.mustNotResolveBy).toBe("DENSE_SCORE_ONLY");
    expect(truth?.mustExposeContradiction).toBe(true);
    expect(truth?.readTimeSupportValidationRequired).toBe(true);

    const tokenCase = pack.cases.find(
      (item) => item.kind === "TOKENIZATION_AND_EXACT_IDENTIFIER",
    );
    expect(tokenCase).toBeDefined();

    const token = tokenCase?.expectations;
    expect(token?.benchmarkLanguages).toEqual(["en", "es", "code"]);
    expect(token?.approximateFallbackMustBeLabeled).toBe(true);
    expect(token?.serializedContextPacketMeasured).toBe(true);
    expect(token?.exactOrLexicalIdentifierChannelRequired).toBe(true);

    const placementCase = pack.cases.find(
      (item) => item.kind === "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS",
    );
    expect(placementCase).toBeDefined();

    const placement = placementCase?.expectations;
    expect(placement?.rulePlacedBeforeHigherScoreConcept).toBe(true);
    expect(placement?.requiredActionsRetainedInFullPacket).toBe(true);
    expect(placement?.requiredActionsRetainedInCompactPacket).toBe(true);
    expect(placement?.requiredActionOrderPreserved).toBe(true);
    expect(placement?.truncatedEvidenceUsesContinuation).toBe(true);
    expect(placement?.mandatoryActionsNeverMoveIntoRetrievedContent).toBe(true);
  });
});
