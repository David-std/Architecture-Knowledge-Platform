import { describe, expect, it } from "vitest";
import {
  FederationPeerQueryRequest,
  FederationRemoteHit,
  FederationRemoteQueryRequest,
} from "../src/index.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";

describe("federation contracts", () => {
  it("binds revision preferences to the requested remote scope", () => {
    const base = {
      schemaVersion: 1 as const,
      caller: {
        nodeId: "team-node-a",
        requestId: "44444444-4444-4444-8444-444444444444",
      },
      scope: { spaceId: SPACE_ID, vaultIds: [VAULT_ID] },
      request: { query: "cache invalidation" },
      budget: {
        maxResults: 20,
        maxWallMs: 5_000,
        maxResponseBytes: 1_000_000,
      },
      revisionPreferences: [{ vaultId: VAULT_ID, corpusRevision: "corpus:r1" }],
    };
    expect(FederationRemoteQueryRequest.parse(base).scope.vaultIds).toEqual([
      VAULT_ID,
    ]);
    expect(
      FederationRemoteQueryRequest.safeParse({
        ...base,
        revisionPreferences: [
          {
            vaultId: "55555555-5555-4555-8555-555555555555",
            corpusRevision: "corpus:r1",
          },
        ],
      }).success,
    ).toBe(false);
    const { caller, ...peerBase } = base;
    expect(
      FederationPeerQueryRequest.parse({
        ...peerBase,
        requestId: caller.requestId,
      }).requestId,
    ).toBe(caller.requestId);
  });

  it("rejects any attempt to rewrite remote trust, lifecycle, or revision", () => {
    const hit = {
      documentId: DOCUMENT_ID,
      vaultId: VAULT_ID,
      document: {
        externalId: null,
        path: "20-knowledge/rule/cache.md",
        title: "Cache",
      },
      revision: "doc:r1",
      title: "Cache",
      type: "rule",
      trust: "MACHINE_SUPPORTED" as const,
      lifecycle: "ACTIVE" as const,
      refreshStatus: "CURRENT",
      score: 1,
      reasons: ["exact:title"],
      excerpt: "Bounded excerpt",
      citations: ["SRC-1"],
      remoteProvenance: {
        nodeId: "team-node-b",
        nodeRevision: "build:r1",
        documentRevision: "doc:r1",
        trust: "MACHINE_SUPPORTED" as const,
        lifecycle: "ACTIVE" as const,
      },
    };
    expect(FederationRemoteHit.parse(hit).trust).toBe("MACHINE_SUPPORTED");
    expect(
      FederationRemoteHit.safeParse({
        ...hit,
        remoteProvenance: {
          ...hit.remoteProvenance,
          trust: "ATTESTED",
        },
      }).success,
    ).toBe(false);
  });
});
