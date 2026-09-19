import { describe, expect, it } from "vitest";
import { planQuery } from "@akp/retrieval";
import type { ContextRevisionSet } from "@akp/contracts";
import {
  plannerCapabilitiesForIndex,
  sameReasoningRevisionSet,
} from "../src/routes/search.js";

const policy = {
  vectorProviderAvailable: true,
  communityAvailable: false,
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
      communityAvailable: false,
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

describe("reasoning revision fence", () => {
  const revisionSet = (): ContextRevisionSet => ({
    spaceId: "00000000-0000-4000-8000-000000000003",
    vaults: [
      {
        vaultId: "10000000-0000-4000-8000-000000000001",
        corpusRevision: "corpus-r2",
        lexicalRevision: "corpus-r2",
        vectorRevision: "corpus-r2",
        graphRevision: "corpus-r2",
        contextPackRevision: "corpus-r2",
        communityRevision: "community-r2",
      },
    ],
    retrievalConfigurationVersion: "rrf-v2",
    capturedAt: "2026-09-19T00:00:00.000Z",
  });

  it("ignores capture time but rejects any material revision/configuration change", () => {
    const planned = revisionSet();
    expect(
      sameReasoningRevisionSet(planned, {
        ...revisionSet(),
        capturedAt: "2026-09-19T00:00:30.000Z",
      }),
    ).toBe(true);

    for (const mutation of [
      { corpusRevision: "corpus-r3" },
      { lexicalRevision: "lexical-r3" },
      { vectorRevision: "vector-r3" },
      { graphRevision: "graph-r3" },
      { contextPackRevision: "context-r3" },
      { communityRevision: "community-r3" },
    ]) {
      const current = revisionSet();
      current.vaults[0] = { ...current.vaults[0]!, ...mutation };
      expect(sameReasoningRevisionSet(planned, current)).toBe(false);
    }

    expect(
      sameReasoningRevisionSet(planned, {
        ...revisionSet(),
        retrievalConfigurationVersion: "rrf-v3",
      }),
    ).toBe(false);
  });
});
