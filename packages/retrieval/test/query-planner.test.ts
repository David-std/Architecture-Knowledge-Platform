import { describe, expect, it } from "vitest";
import { planQuery } from "../src/query-planner.js";

describe("query planner", () => {
  it("uses exact channels for stable identifiers", () => {
    expect(planQuery("ADR-001-SEPARATE-VAULT").channels).toEqual([
      "exact",
      "lexical",
    ]);
  });

  it("requires raw evidence for source verification", () => {
    const plan = planQuery("verifica la fuente y la evidencia de este claim");
    expect(plan.intent).toBe("SOURCE_VERIFICATION");
    expect(plan.channels).toContain("raw");
    expect(plan.requireEvidence).toBe(true);
  });

  it("routes code questions to the code adapter", () => {
    expect(
      planQuery("¿qué clase implementa este repositorio?").channels,
    ).toContain("code");
  });
});
