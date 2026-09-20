import { describe, expect, it } from "vitest";
import {
  GraphCatalogEntry,
  GraphNodeIdentity,
  GraphPathResult,
  GraphProvenanceEnvelope,
  GraphRelationshipAssertion,
  GraphTraversalBounds,
  graphNodeIdentityKey,
} from "../src/federated-graph.js";

const recordedAt = "2026-09-18T00:00:00.000Z";

describe("federated graph contracts", () => {
  it("validates graph catalog capability metadata without inventing availability", () => {
    const entry = GraphCatalogEntry.parse({
      domain: "CODE",
      spaceId: "22222222-2222-4222-8222-222222222222",
      vaultId: "33333333-3333-4333-8333-333333333333",
      scopeId: "repo:payments",
      activeRevision: "code:r1",
      sourceRevision: "a".repeat(40),
      builder: "graphify",
      builderVersion: "0.9.63",
      configHash: "b".repeat(64),
      status: "READY",
      capabilities: ["symbol-structure", "typed-traversal", "impact"],
      lastSuccessfulBuild: recordedAt,
    });

    expect(entry.status).toBe("READY");
    expect(
      GraphCatalogEntry.safeParse({ ...entry, configHash: "not-a-hash" })
        .success,
    ).toBe(false);
  });

  it("keeps identical display keys distinct across domains, scopes and revisions", () => {
    const epistemic = GraphNodeIdentity.parse({
      graphDomain: "EPISTEMIC",
      scopeId: "vault-a",
      kind: "rule",
      canonicalKey: "payments-api",
      revision: "knowledge:r1",
    });
    const catalog = GraphNodeIdentity.parse({
      graphDomain: "SOFTWARE_CATALOG",
      scopeId: "vault-a",
      kind: "service",
      canonicalKey: "payments-api",
      revision: "catalog:r1",
    });
    const otherVault = GraphNodeIdentity.parse({
      graphDomain: "SOFTWARE_CATALOG",
      scopeId: "vault-b",
      kind: "service",
      canonicalKey: "payments-api",
      revision: "catalog:r1",
    });

    expect(graphNodeIdentityKey(epistemic)).not.toBe(
      graphNodeIdentityKey(catalog),
    );
    expect(graphNodeIdentityKey(catalog)).not.toBe(
      graphNodeIdentityKey(otherVault),
    );
  });

  it("requires explicit derivation while leaving deterministic confidence unset", () => {
    const provenance = GraphProvenanceEnvelope.parse({
      derivation: "STATICALLY_RESOLVED",
      sourceIds: ["repo@sha"],
      evidenceIds: [],
      locatorRefs: ["src/client.ts#ServiceClient"],
      revision: "code:r1",
      recordedAt,
    });

    expect(provenance.confidence).toBeUndefined();
    expect(
      GraphProvenanceEnvelope.safeParse({
        ...provenance,
        validFrom: "2026-09-19T00:00:00.000Z",
        validTo: "2026-09-18T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("models relationship assertions as first-class lifecycle-bearing objects", () => {
    const assertion = GraphRelationshipAssertion.parse({
      id: "77777777-7777-4777-8777-777777777777",
      spaceId: "22222222-2222-4222-8222-222222222222",
      ownerGraphDomain: "SOFTWARE_CATALOG",
      fromNodeId: "11111111-1111-4111-8111-111111111111",
      toNodeId: "55555555-5555-4555-8555-555555555555",
      relation: "depends_on",
      authorizationPath: "catalog/payments",
      lifecycle: "DISPUTED",
      provenance: {
        derivation: "SOURCE_EXPLICIT",
        sourceIds: ["catalog-source-a", "catalog-source-b"],
        evidenceIds: ["review-42"],
        locatorRefs: [],
        revision: "catalog:r1",
        recordedAt,
      },
    });

    expect(assertion.lifecycle).toBe("DISPUTED");
    expect(assertion.provenance.sourceIds).toEqual([
      "catalog-source-a",
      "catalog-source-b",
    ]);
  });

  it("rejects unbounded traversal requests", () => {
    expect(
      GraphTraversalBounds.safeParse({
        maxHops: 17,
        maxFanout: 10,
        maxCandidates: 100,
        timeBudgetMs: 500,
      }).success,
    ).toBe(false);
    expect(
      GraphTraversalBounds.safeParse({
        maxHops: 3,
        maxFanout: 10,
        maxCandidates: 100,
        timeBudgetMs: 500,
      }).success,
    ).toBe(true);
  });

  it("retains per-domain revisions on cross-domain paths", () => {
    const node = {
      id: "11111111-1111-4111-8111-111111111111",
      spaceId: "22222222-2222-4222-8222-222222222222",
      vaultId: "33333333-3333-4333-8333-333333333333",
      authorizationPath: null,
      identity: {
        graphDomain: "SOFTWARE_CATALOG" as const,
        scopeId: "catalog-a",
        kind: "service",
        canonicalKey: "payments-api",
        revision: "catalog:r1",
      },
      payload: {},
      projection: {
        id: "44444444-4444-4444-8444-444444444444",
        revision: "catalog:r1",
        lifecycle: "ACTIVE" as const,
        freshness: "FRESH" as const,
      },
    };
    const target = {
      ...node,
      id: "55555555-5555-4555-8555-555555555555",
      identity: {
        graphDomain: "CODE" as const,
        scopeId: "repo-a",
        kind: "symbol",
        canonicalKey: "repo@sha:src/client.ts#ServiceClient",
        revision: "code:r7",
      },
      projection: {
        ...node.projection,
        id: "66666666-6666-4666-8666-666666666666",
        revision: "code:r7",
      },
    };

    const parsed = GraphPathResult.parse({
      seed: node,
      target,
      steps: [
        {
          from: node,
          relation: "implemented_by",
          direction: "outgoing",
          to: target,
          assertion: {
            id: "77777777-7777-4777-8777-777777777777",
            spaceId: "22222222-2222-4222-8222-222222222222",
            ownerGraphDomain: "SOFTWARE_CATALOG",
            fromNodeId: node.id,
            toNodeId: target.id,
            relation: "implemented_by",
            authorizationPath: null,
            lifecycle: "ACTIVE",
            provenance: {
              derivation: "HUMAN_ASSERTED",
              sourceIds: ["catalog-entry"],
              evidenceIds: ["review-42"],
              locatorRefs: [],
              revision: "bridge:r1",
              recordedAt,
            },
          },
          provenance: {
            derivation: "HUMAN_ASSERTED",
            sourceIds: ["catalog-entry"],
            evidenceIds: ["review-42"],
            locatorRefs: [],
            revision: "bridge:r1",
            recordedAt,
          },
        },
      ],
      revisionSet: {
        SOFTWARE_CATALOG: "catalog:r1",
        CODE: "code:r7",
      },
    });

    expect(parsed.revisionSet).toEqual({
      SOFTWARE_CATALOG: "catalog:r1",
      CODE: "code:r7",
    });
  });
});
