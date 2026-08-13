import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvaluationPack, REQUIRED_GENERIC_SLICES } from "../src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("evaluation pack isolation", () => {
  it("loads the generic pack without course-specific identifiers", async () => {
    const cases = await loadEvaluationPack(repositoryRoot, "generic");
    expect(cases.length).toBeGreaterThan(0);
    expect(JSON.stringify(cases)).not.toMatch(/SI729|SI730|WF-DDD-END-TO-END/);
    const slices = new Set(cases.map((testCase) => testCase.slice));
    for (const slice of REQUIRED_GENERIC_SLICES)
      expect(slices.has(slice)).toBe(true);
  });

  it("loads the Architecture Knowledge System pack only when requested", async () => {
    const cases = await loadEvaluationPack(
      repositoryRoot,
      "architecture-knowledge-system",
    );
    expect(cases.some((testCase) => testCase.id === "resources-layer")).toBe(
      true,
    );
  });
});
