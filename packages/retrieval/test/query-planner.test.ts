import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY_PLANNER_CAPABILITIES,
  planQuery,
} from "../src/query-planner.js";

describe("query planner", () => {
  it("uses exact channels for stable identifiers", () => {
    expect(planQuery("ADR-001-SEPARATE-VAULT").channels).toEqual([
      "exact",
      "lexical",
    ]);
  });

  it("requires raw evidence for source verification", () => {
    const plan = planQuery("verifica la fuente y la evidencia de este claim", {
      rawAllowed: true,
    });
    expect(plan.intent).toBe("SOURCE_VERIFICATION");
    expect(plan.channels).toContain("raw");
    expect(plan.requireEvidence).toBe(true);
  });

  it("routes code questions to the code adapter", () => {
    expect(
      planQuery("¿qué clase implementa este repositorio?", {
        codeAdapterAvailable: true,
      }).channels,
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
      maxGraphHops: 0,
    });
  });

  it("reserves deeper graph traversal for impact analysis", () => {
    expect(
      planQuery("trace the dependency impact", "IMPACT_ANALYSIS", {
        graphConsistent: true,
      }),
    ).toMatchObject({
      intent: "IMPACT_ANALYSIS",
      maxGraphHops: 3,
    });
    expect(
      planQuery("trace the dependency impact", "CONCEPTUAL").maxGraphHops,
    ).toBe(0);
  });

  it("gates optional channels by explicit runtime capabilities", () => {
    const plan = planQuery(
      "impacto: verifica el repositorio y la fuente",
      "SOURCE_VERIFICATION",
      {
        vectorAvailable: false,
        graphConsistent: false,
        rawAllowed: false,
        codeAdapterAvailable: false,
        contextPackAvailable: false,
      },
    );

    expect(plan).toMatchObject({
      intent: "SOURCE_VERIFICATION",
      channels: ["exact", "lexical"],
      maxGraphHops: 0,
      requireEvidence: true,
      omittedChannels: ["graph", "raw"],
    });
    expect(plan.capabilities).toEqual({
      vectorAvailable: false,
      graphConsistent: false,
      rawAllowed: false,
      codeAdapterAvailable: false,
      contextPackAvailable: false,
    });
  });

  it("keeps exact and lexical as deterministic first-class fallbacks", () => {
    const plan = planQuery("impacto de cambios", {
      requestedIntent: "IMPACT_ANALYSIS",
      capabilities: {
        graphConsistent: false,
      },
    });

    expect(plan.intent).toBe("IMPACT_ANALYSIS");
    expect(plan.channels).toEqual(["exact"]);
    expect(plan.omittedChannels).toEqual(["graph"]);
    expect(plan.maxGraphHops).toBe(0);
  });

  it("accepts a capabilities-only third argument for legacy callers", () => {
    const plan = planQuery("global synthesis", undefined, {
      vectorAvailable: false,
      graphConsistent: false,
    });

    expect(plan.channels).toEqual(["lexical"]);
    expect(plan.maxGraphHops).toBe(0);
    expect(plan.omittedChannels).toEqual(["vector", "graph"]);
  });

  it("accepts a capabilities-only options shorthand", () => {
    const plan = planQuery("global synthesis", {
      vectorAvailable: false,
      graphConsistent: false,
    });

    expect(plan.channels).toEqual(["lexical"]);
    expect(plan.capabilities.vectorAvailable).toBe(false);
  });

  it("gates every optional channel while preserving policy order", () => {
    const plan = planQuery("project code workflow", "PROJECT_CODE", {
      contextPackAvailable: false,
      graphConsistent: false,
      codeAdapterAvailable: false,
    });

    expect(plan.intent).toBe("PROJECT_CODE");
    expect(plan.channels).toEqual(["exact", "lexical"]);
    expect(plan.omittedChannels).toEqual(["context-pack", "graph", "code"]);
  });

  it("does not let query heuristics override an explicit intent", () => {
    const plan = planQuery("impacto de código y fuentes", {
      requestedIntent: "CONCEPTUAL",
      capabilities: {
        graphConsistent: false,
        rawAllowed: false,
      },
    });

    expect(plan.intent).toBe("CONCEPTUAL");
    expect(plan.channels).toEqual(["exact", "lexical"]);
  });

  it("fails unknown optional capabilities closed and produces repeatable plans", () => {
    const first = planQuery("global architecture synthesis");
    const second = planQuery("global architecture synthesis");

    expect(first).toEqual(second);
    expect(first.capabilities).toEqual(DEFAULT_QUERY_PLANNER_CAPABILITIES);
    expect(first.channels).toEqual(["lexical"]);
    expect(first.omittedChannels).toEqual(["vector", "graph"]);
  });
});
