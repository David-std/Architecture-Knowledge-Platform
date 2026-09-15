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
  it("pins temporal contradiction and tokenization regressions without changing defaults", async () => {
    const pack = await loadRegressionPack();
    expect(pack.schemaVersion).toBe(1);
    expect(pack.productionDefaultsChanged).toBe(false);
    expect(pack.evidenceLevel).toBe("P0_REGRESSION_SPEC");

    const temporal = pack.cases.find(
      (testCase) => testCase.kind === "TEMPORAL_TRUTH_CONTRADICTION",
    );
    expect(temporal).toBeDefined();
    expect(temporal?.denseScores?.["security-guide-v1"] ?? 0).toBeGreaterThan(
      temporal?.denseScores?.["security-guide-v3"] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      Math.abs(
        (temporal?.denseScores?.["security-guide-v1"] ?? 0) -
          (temporal?.denseScores?.["security-guide-v3"] ?? 0),
      ),
    ).toBeLessThan(0.01);
    expect(temporal?.expectations.current).toEqual(["security-guide-v3"]);
    expect(temporal?.expectations.asOfBeforeChange).toEqual([
      "security-guide-v1",
    ]);
    expect(temporal?.expectations.mustNotResolveBy).toBe("DENSE_SCORE_ONLY");
    expect(temporal?.expectations.mustExposeContradiction).toBe(true);
    expect(temporal?.expectations.readTimeSupportValidationRequired).toBe(true);

    const tokenCase = pack.cases.find(
      (testCase) => testCase.kind === "TOKENIZATION_AND_EXACT_IDENTIFIER",
    );
    expect(tokenCase).toBeDefined();
    expect(tokenCase?.expectations.benchmarkLanguages).toEqual([
      "en",
      "es",
      "code",
    ]);
    expect(tokenCase?.expectations.approximateFallbackMustBeLabeled).toBe(true);
    expect(tokenCase?.expectations.serializedContextPacketMeasured).toBe(true);
    expect(tokenCase?.expectations.exactOrLexicalIdentifierChannelRequired).toBe(
      true,
    );
  });
});
