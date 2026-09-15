import { describe, expect, it } from "vitest";
import { planQuery } from "@akp/retrieval";
import { plannerCapabilitiesForIndex } from "../src/routes/search.js";

const policy = {
  vectorProviderAvailable: true,
  rawAllowed: true,
  codeAdapterAvailable: true,
};

describe("retrieval capability degradation", () => {
  it("omits graph retrieval when its projection revision does not match the corpus", () => {
    const capabilities = plannerCapabilitiesForIndex(
      {
        corpus_revision: "corpus-r2",
        lexical_revision: "corpus-r2",
        vector_revision: "corpus-r2",
        graph_revision: "corpus-r1",
        context_pack_revision: "corpus-r2",
      },
      policy,
    );

    expect(capabilities).toMatchObject({
      vectorAvailable: true,
      graphConsistent: false,
      rawAllowed: true,
      codeAdapterAvailable: true,
      contextPackAvailable: true,
    });

    const plan = planQuery(
      "trace the dependency impact",
      "IMPACT_ANALYSIS",
      capabilities,
    );
    expect(plan.channels).not.toContain("graph");
    expect(plan.omittedChannels).toContain("graph");
    expect(plan.maxGraphHops).toBe(0);
  });
});
