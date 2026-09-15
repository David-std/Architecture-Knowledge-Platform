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
      (testCase) => testCase.kind === "TEMPORAL_TRUTH_CONTRADICTION",
    );
    expect(temporal).toBeDefined();

    const oldScore = temporal?.denseScores?.["security-guide-v1"] ?? 0;
    const currentScore = temporal?.denseScores?.["security-guide-v3"] ?? Infinity;
    expect(oldScore).toBeGreaterThan(currentScore);
    expect(Math.abs(oldScore - currentScore)).toBeLessThan(0.01);

    const temporalExpectations = temporal?.expectations;
    expect(temporalExpectations?.current).toEqual(["security-guide-v3"]);
    expect(temporalExpectations?.asOfBeforeChange).toEqual([
      "security-guide-v1",
    ]);
    expect(temporalExpectations?.mustNotResolveBy).toBe("DENSE_SCORE_ONLY");
    expect(temporalExpectations?.mustExposeContradiction).toBe(true);
    expect(temporalExpectations?.readTimeSupportValidationRequired).toBe(true);

    const tokenCase = pack.cases.find(
      (testCase) => testCase.kind === "TOKENIZATION_AND_EXACT_IDENTIFIER",
    );
    expect(tokenCase).toBeDefined();

    const tokenExpectations = tokenCase?.expectations;
    expect(tokenExpectations?.benchmarkLanguages).toEqual(["en", "es", "code"]);
    expect(tokenExpectations?.approximateFallbackMustBeLabeled).toBe(true);
    expect(tokenExpectations?.serializedContextPacketMeasured).toBe(true);
    expect(tokenExpectations?.exactOrLexicalIdentifierChannelRequired).toBe(true);
  });
});
