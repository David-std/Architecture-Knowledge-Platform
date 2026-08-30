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

  it("recognizes stable identifiers without a vault-specific prefix list", () => {
    expect(planQuery("ERR-NMB-042").intent).toBe("EXACT_LOOKUP");
    expect(planQuery("POLICY_17").intent).toBe("EXACT_LOOKUP");
    expect(planQuery("/src/cache/refresh.py").intent).toBe("EXACT_LOOKUP");
  });

  it("honors an explicit supported intent and can disable retrieval", () => {
    expect(planQuery("compare these two notes", "EXACT_LOOKUP").intent).toBe(
      "EXACT_LOOKUP",
    );
    expect(
      planQuery("the answer is already in the caller", "NO_RETRIEVAL_REQUIRED"),
    ).toMatchObject({
      intent: "NO_RETRIEVAL_REQUIRED",
      channels: [],
      maxGraphHops: 1,
    });
  });
});
