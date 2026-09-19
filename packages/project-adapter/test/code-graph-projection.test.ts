import { describe, expect, it } from "vitest";
import type { CodeGraphArtifact } from "@akp/contracts";
import { planCodeGraphProjection } from "../src/index.js";

const artifact: CodeGraphArtifact = {
  schemaVersion: 1,
  repository: "akp-project:vault:payments",
  commitSha: "1".repeat(40),
  provider: "graphify",
  providerVersion: "0.9.63",
  configurationHash: "2".repeat(64),
  generatedAt: "2026-09-18T00:00:00.000Z",
  languages: ["TypeScript"],
  nodes: [
    {
      id: "entry",
      kind: "FUNCTION",
      name: "entry",
      qualifiedName: "entry",
      path: "src/entry.ts",
      lineStart: 1,
      lineEnd: 4,
    },
    {
      id: "helper",
      kind: "FUNCTION",
      name: "helper",
      qualifiedName: "helper",
      path: "src/helper.ts",
      lineStart: 1,
      lineEnd: 4,
    },
  ],
  edges: [
    {
      id: "static-edge",
      sourceId: "entry",
      targetId: "helper",
      relation: "CALLS",
      derivation: "STATICALLY_RESOLVED",
    },
    {
      id: "candidate-edge",
      sourceId: "helper",
      targetId: "entry",
      relation: "REFERENCES",
      derivation: "INFERRED",
      confidence: 0.73,
    },
  ],
  warnings: [],
};

describe("code graph projection", () => {
  it("keeps repository paths in payloads while scoping authorization paths under the project", () => {
    const plan = planCodeGraphProjection({
      artifact,
      spaceId: "00000000-0000-0000-0000-000000000003",
      vaultId: "00000000-0000-0000-0000-000000000004",
      scopeId: "project:payments",
      authorizationPathPrefix: "projects/payments",
    });

    expect(
      plan.projection.nodes.map((node) => ({
        authorizationPath: node.authorizationPath,
        path: node.payload.path,
      })),
    ).toEqual([
      {
        authorizationPath: "projects/payments/src/entry.ts",
        path: "src/entry.ts",
      },
      {
        authorizationPath: "projects/payments/src/helper.ts",
        path: "src/helper.ts",
      },
    ]);
    expect(plan.projection.edges).toHaveLength(1);
    expect(plan.projection.edges[0]).toMatchObject({
      relation: "calls",
      authorizationPath: "projects/payments/src/entry.ts",
      provenance: {
        derivation: "STATICALLY_RESOLVED",
      },
    });
  });

  it("keeps inferred provider edges out of the authoritative graph instead of upgrading them", () => {
    const plan = planCodeGraphProjection({
      artifact,
      spaceId: "00000000-0000-0000-0000-000000000003",
      vaultId: "00000000-0000-0000-0000-000000000004",
      scopeId: "project:payments",
    });

    expect(plan.skippedCandidateEdgeIds).toEqual(["candidate-edge"]);
    expect(plan.projection.edges).toHaveLength(1);
    expect(
      plan.projection.edges.some(
        (edge) => edge.provenance.derivation === "DETERMINISTIC_EXTRACTED",
      ),
    ).toBe(false);
  });

  it("rejects path traversal before an authorization path can enter the graph store", () => {
    expect(() =>
      planCodeGraphProjection({
        artifact: {
          ...artifact,
          nodes: [
            {
              ...artifact.nodes[0]!,
              path: "../private/secret.ts",
            },
          ],
          edges: [],
        },
        spaceId: "00000000-0000-0000-0000-000000000003",
        vaultId: "00000000-0000-0000-0000-000000000004",
        scopeId: "project:payments",
        authorizationPathPrefix: "projects/payments",
      }),
    ).toThrow("CODE_GRAPH_AUTHORIZATION_PATH_INVALID");
  });
});
