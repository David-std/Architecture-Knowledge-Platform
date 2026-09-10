import { describe, expect, it } from "vitest";
import { GraphPathProvenance, SearchHit } from "../src/index.js";

const provenance = {
  channel: "graph" as const,
  seedDocumentId: "11111111-1111-4111-8111-111111111111",
  targetDocumentId: "33333333-3333-4333-8333-333333333333",
  path: [
    {
      documentId: "11111111-1111-4111-8111-111111111111",
      document: "A",
      relation: "requires" as const,
      direction: "outgoing" as const,
    },
    {
      documentId: "22222222-2222-4222-8222-222222222222",
      document: "B",
      relation: "validated_by" as const,
      direction: "outgoing" as const,
    },
    {
      documentId: "33333333-3333-4333-8333-333333333333",
      document: "C",
    },
  ],
  hops: 2,
  graphScore: 0.125,
};

describe("graph provenance contracts", () => {
  it("accepts a typed multi-hop route on a search hit", () => {
    expect(GraphPathProvenance.parse(provenance)).toEqual(provenance);
    expect(
      SearchHit.parse({
        documentId: provenance.targetDocumentId,
        vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: "revision-1",
        title: "C",
        type: "concept",
        trust: "HUMAN_REVIEWED",
        lifecycle: "ACTIVE",
        score: 1,
        reasons: ["graph"],
        excerpt: "C",
        citations: [],
        graphProvenance: [provenance],
      }).graphProvenance,
    ).toEqual([provenance]);
  });

  it("rejects untyped relations and incomplete paths", () => {
    expect(
      GraphPathProvenance.safeParse({
        ...provenance,
        path: [
          {
            ...provenance.path[0],
            relation: "vault_specific_relation",
          },
          provenance.path[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      GraphPathProvenance.safeParse({
        ...provenance,
        path: [provenance.path[0]],
      }).success,
    ).toBe(false);
  });
});
