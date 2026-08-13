import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOfflineBenchmarkReport,
  loadEvaluationPack,
} from "../src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("offline retrieval benchmark", () => {
  it("is deterministic, synthetic-only and does not select a production default", async () => {
    const cases = await loadEvaluationPack(repositoryRoot, "generic");
    const input = {
      datasetRoot: "evals/generic",
      datasetHash: "fixture-hash",
      datasetFiles: { "retrieval/basic.jsonl": "file-hash" },
      runnerHash: "runner-hash",
      generatedAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const first = buildOfflineBenchmarkReport(cases, input);
    const second = buildOfflineBenchmarkReport(cases, input);

    expect(first).toEqual(second);
    expect(first.status).toBe("IMPLEMENTED_AND_EXECUTED");
    expect(first.evidenceLevel).toBe("LOGIC_ONLY_SYNTHETIC");
    expect(first.qualityClaim).toBe("NONE");
    expect(first.provider.readsPrivateVault).toBe(false);
    expect(first.provider.readsDatabase).toBe(false);
    expect(first.matrix.size).toBe(10);
    expect(first.requiredSlices).toContain("vector-disabled");
    expect(first.vectorDisabled.vectorInvoked).toBe(false);
    expect(first.productionDefault.selected).toBeNull();
    expect(first.measuredSelection.vectorActivatedByDefault).toBe(false);
    expect(first.runs).toHaveLength(10);
    expect(first.runs.every((run) => run.cases === cases.length)).toBe(true);
    expect(first.runs.every((run) => run.evidenceRecallCoverage === 0)).toBe(
      true,
    );
  });
});
