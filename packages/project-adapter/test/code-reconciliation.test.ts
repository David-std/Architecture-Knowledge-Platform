import { describe, expect, it } from "vitest";
import type { CodeGraphArtifact, GraphNodeRef } from "@akp/contracts";
import { reconcileCodeGraphCandidates } from "../src/index.js";

function previousNode(input: {
  id: string;
  path: string;
  name: string;
  qualifiedName?: string;
  lineStart?: number;
  contentHash?: string;
}): GraphNodeRef {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    spaceId: "00000000-0000-0000-0000-000000000003",
    vaultId: "00000000-0000-0000-0000-000000000004",
    authorizationPath: input.path,
    identity: {
      graphDomain: "CODE",
      scopeId: "repo:fixture",
      kind: "FUNCTION",
      canonicalKey: input.id,
      revision: "old-projection",
    },
    payload: {
      codeNodeId: input.id,
      repository: "fixture",
      commitSha: "1".repeat(40),
      kind: "FUNCTION",
      name: input.name,
      ...(input.qualifiedName
        ? { qualifiedName: input.qualifiedName }
        : {}),
      path: input.path,
      ...(input.lineStart ? { lineStart: input.lineStart } : {}),
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    },
    projection: {
      id: "00000000-0000-0000-0000-000000000002",
      revision: "old-projection",
      lifecycle: "ACTIVE",
      freshness: "FRESH",
    },
  };
}

function artifact(
  node: CodeGraphArtifact["nodes"][number],
): CodeGraphArtifact {
  return {
    schemaVersion: 1,
    repository: "fixture",
    commitSha: "2".repeat(40),
    provider: "fixture",
    providerVersion: "1",
    configurationHash: "a".repeat(64),
    generatedAt: "2026-09-18T00:00:00.000Z",
    languages: ["TypeScript"],
    nodes: [node],
    edges: [],
    warnings: [],
  };
}

describe("code graph reconciliation candidates", () => {
  it("represents a deterministic move as a candidate without reusing identity", () => {
    const contentHash = "b".repeat(64);
    const candidates = reconcileCodeGraphCandidates(
      [
        previousNode({
          id: "old-entry",
          path: "src/legacy/entry.ts",
          name: "entry",
          qualifiedName: "entry",
          lineStart: 2,
          contentHash,
        }),
      ],
      artifact({
        id: "new-entry",
        kind: "FUNCTION",
        name: "entry",
        qualifiedName: "entry",
        path: "src/entry.ts",
        lineStart: 2,
        contentHash,
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      relationship: "MOVED_FROM",
      state: "CANDIDATE",
      basis: expect.arrayContaining([
        "SAME_QUALIFIED_NAME",
        "SAME_NAME",
        "SAME_CONTENT_HASH",
      ]),
      from: {
        nodeId: "old-entry",
        commitSha: "1".repeat(40),
        path: "src/legacy/entry.ts",
      },
      to: {
        nodeId: "new-entry",
        commitSha: "2".repeat(40),
        path: "src/entry.ts",
      },
    });
    expect(candidates[0]?.from.nodeId).not.toBe(candidates[0]?.to.nodeId);
  });

  it("keeps tied move matches ambiguous instead of selecting an identity", () => {
    const contentHash = "c".repeat(64);
    const candidates = reconcileCodeGraphCandidates(
      [
        previousNode({
          id: "old-a",
          path: "src/a.ts",
          name: "same",
          qualifiedName: "same",
          contentHash,
        }),
        previousNode({
          id: "old-b",
          path: "src/b.ts",
          name: "same",
          qualifiedName: "same",
          contentHash,
        }),
      ],
      artifact({
        id: "new-same",
        kind: "FUNCTION",
        name: "same",
        qualifiedName: "same",
        path: "src/new.ts",
        contentHash,
      }),
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.state === "AMBIGUOUS")).toBe(
      true,
    );
  });

  it("represents a same-position symbol rename only as a low-confidence candidate", () => {
    const candidates = reconcileCodeGraphCandidates(
      [
        previousNode({
          id: "old-name",
          path: "src/service.ts",
          name: "oldName",
          lineStart: 11,
        }),
      ],
      artifact({
        id: "new-name",
        kind: "FUNCTION",
        name: "newName",
        path: "src/service.ts",
        lineStart: 11,
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      relationship: "RENAMED_FROM",
      state: "CANDIDATE",
      confidence: 0.45,
      basis: ["SAME_POSITION"],
    });
  });
});
