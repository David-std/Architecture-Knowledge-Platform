import { describe, expect, it } from "vitest";

import {
  personalizedPageRank,
  resolvePersonalizedPageRankPolicy,
} from "../src/ppr.js";

describe("personalized PageRank", () => {
  it("ranks authorized weighted neighbors deterministically", () => {
    const input = {
      nodes: [
        { id: "seed", scopeId: "vault-a", graphDomain: "EPISTEMIC" },
        { id: "strong", scopeId: "vault-a", graphDomain: "EPISTEMIC" },
        { id: "weak", scopeId: "vault-a", graphDomain: "EPISTEMIC" },
      ],
      edges: [
        {
          fromNodeId: "seed",
          toNodeId: "weak",
          scopeId: "vault-a",
          relation: "related_to",
          weight: 1,
        },
        {
          fromNodeId: "seed",
          toNodeId: "strong",
          scopeId: "vault-a",
          relation: "supports",
          weight: 4,
        },
        {
          fromNodeId: "strong",
          toNodeId: "seed",
          scopeId: "vault-a",
          relation: "supports",
          weight: 1,
        },
      ],
      seeds: [{ nodeId: "seed", weight: 1 }],
      policy: {
        allowedRelations: ["supports", "related_to"],
        maxIterations: 100,
        tolerance: 1e-12,
      },
    } as const;

    const first = personalizedPageRank(input);
    const second = personalizedPageRank({
      ...input,
      nodes: [...input.nodes].reverse(),
      edges: [...input.edges].reverse(),
    });

    expect(first.converged).toBe(true);
    expect(first.candidates).toEqual(second.candidates);
    expect(first.candidates.find((item) => item.nodeId === "strong")?.score).toBeGreaterThan(
      first.candidates.find((item) => item.nodeId === "weak")?.score ?? 0,
    );
    expect(
      first.candidates.reduce((sum, candidate) => sum + candidate.score, 0),
    ).toBeCloseTo(1, 8);
  });

  it("filters graph domains and relations before scoring", () => {
    const result = personalizedPageRank({
      nodes: [
        { id: "seed", scopeId: "vault-a", graphDomain: "EPISTEMIC" },
        { id: "allowed", scopeId: "vault-a", graphDomain: "EPISTEMIC" },
        { id: "runtime", scopeId: "vault-a", graphDomain: "RUNTIME" },
      ],
      edges: [
        {
          fromNodeId: "seed",
          toNodeId: "allowed",
          scopeId: "vault-a",
          relation: "supports",
          weight: 1,
        },
        {
          fromNodeId: "seed",
          toNodeId: "runtime",
          scopeId: "vault-a",
          relation: "supports",
          weight: 10,
        },
        {
          fromNodeId: "allowed",
          toNodeId: "seed",
          scopeId: "vault-a",
          relation: "contradicts",
          weight: 100,
        },
      ],
      seeds: [{ nodeId: "seed", weight: 1 }],
      policy: {
        allowedGraphDomains: ["EPISTEMIC"],
        allowedRelations: ["supports"],
      },
    });

    expect(result.candidates.map((candidate) => candidate.nodeId)).toEqual([
      "seed",
      "allowed",
    ]);
    expect(result.edgeCount).toBe(1);
  });

  it("enforces per-scope caps without merging independent scopes", () => {
    const result = personalizedPageRank({
      nodes: [
        { id: "a-seed", scopeId: "a", graphDomain: "EPISTEMIC" },
        { id: "a-next", scopeId: "a", graphDomain: "EPISTEMIC" },
        { id: "b-seed", scopeId: "b", graphDomain: "EPISTEMIC" },
        { id: "b-next", scopeId: "b", graphDomain: "EPISTEMIC" },
      ],
      edges: [
        {
          fromNodeId: "a-seed",
          toNodeId: "a-next",
          scopeId: "a",
          relation: "supports",
          weight: 1,
        },
        {
          fromNodeId: "b-seed",
          toNodeId: "b-next",
          scopeId: "b",
          relation: "supports",
          weight: 1,
        },
      ],
      seeds: [
        { nodeId: "a-seed", weight: 1 },
        { nodeId: "b-seed", weight: 1 },
      ],
      policy: { allowedRelations: ["supports"], perScopeCap: 1 },
    });

    expect(result.candidates).toHaveLength(2);
    expect(new Set(result.candidates.map((candidate) => candidate.scopeId))).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("fails closed on cross-scope graph edges", () => {
    expect(() =>
      personalizedPageRank({
        nodes: [
          { id: "a", scopeId: "vault-a", graphDomain: "EPISTEMIC" },
          { id: "b", scopeId: "vault-b", graphDomain: "EPISTEMIC" },
        ],
        edges: [
          {
            fromNodeId: "a",
            toNodeId: "b",
            scopeId: "vault-a",
            relation: "supports",
            weight: 1,
          },
        ],
        seeds: [{ nodeId: "a", weight: 1 }],
        policy: { allowedRelations: ["supports"] },
      }),
    ).toThrow("PPR_SCOPE_VIOLATION");
  });

  it("enforces node and policy bounds", () => {
    expect(() =>
      personalizedPageRank({
        nodes: [
          { id: "a", scopeId: "vault", graphDomain: "EPISTEMIC" },
          { id: "b", scopeId: "vault", graphDomain: "EPISTEMIC" },
        ],
        edges: [],
        seeds: [{ nodeId: "a", weight: 1 }],
        policy: { maxNodes: 1 },
      }),
    ).toThrow("PPR_MAX_NODES_EXCEEDED");

    expect(() =>
      resolvePersonalizedPageRankPolicy({ restartProbability: 1 }),
    ).toThrow("restartProbability");
    expect(() =>
      resolvePersonalizedPageRankPolicy({ maxIterations: 0 }),
    ).toThrow("maxIterations");
  });
});
