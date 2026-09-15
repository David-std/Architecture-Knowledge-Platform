import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadContextCorrectnessRegressionPack,
  validateContextCorrectnessRegressionPack,
} from "../src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("context correctness regression contract", () => {
  it("pins temporal contradiction and tokenization regressions without changing defaults", async () => {
    const pack = await loadContextCorrectnessRegressionPack(repositoryRoot);
    expect(pack.productionDefaultsChanged).toBe(false);
    expect(pack.evidenceLevel).toBe("P0_REGRESSION_SPEC");

    const temporal = pack.cases.find(
      (testCase) => testCase.kind === "TEMPORAL_TRUTH_CONTRADICTION",
    );
    if (!temporal || temporal.kind !== "TEMPORAL_TRUTH_CONTRADICTION")
      throw new Error("Temporal regression missing.");

    expect(temporal.denseScores["security-guide-v1"]).toBeGreaterThan(
      temporal.denseScores["security-guide-v3"] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      Math.abs(
        (temporal.denseScores["security-guide-v1"] ?? 0) -
          (temporal.denseScores["security-guide-v3"] ?? 0),
      ),
    ).toBeLessThan(0.01);
    expect(temporal.expectations.current).toEqual(["security-guide-v3"]);
    expect(temporal.expectations.asOfBeforeChange).toEqual([
      "security-guide-v1",
    ]);
    expect(temporal.expectations.mustNotResolveBy).toBe("DENSE_SCORE_ONLY");
    expect(temporal.expectations.mustExposeContradiction).toBe(true);
    expect(temporal.expectations.readTimeSupportValidationRequired).toBe(true);

    const tokenCase = pack.cases.find(
      (testCase) => testCase.kind === "TOKENIZATION_AND_EXACT_IDENTIFIER",
    );
    if (!tokenCase || tokenCase.kind !== "TOKENIZATION_AND_EXACT_IDENTIFIER")
      throw new Error("Tokenization regression missing.");

    expect(tokenCase.expectations.benchmarkLanguages).toEqual([
      "en",
      "es",
      "code",
    ]);
    expect(tokenCase.expectations.approximateFallbackMustBeLabeled).toBe(true);
    expect(tokenCase.expectations.serializedContextPacketMeasured).toBe(true);
    expect(tokenCase.expectations.exactOrLexicalIdentifierChannelRequired).toBe(
      true,
    );
  });

  it("rejects a P0 pack that changes production defaults", () => {
    expect(() =>
      validateContextCorrectnessRegressionPack({
        schemaVersion: 1,
        evidenceLevel: "P0_REGRESSION_SPEC",
        productionDefaultsChanged: true,
        cases: [],
      }),
    ).toThrow("must not change production defaults");
  });
});
