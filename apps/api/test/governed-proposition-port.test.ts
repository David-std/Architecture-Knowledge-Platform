import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@akp/contracts";
import type { GovernedLayeredPropositionPort } from "@akp/retrieval";
import { scopeGovernedLayeredPropositionPort } from "../src/routes/search.js";

const candidate: SearchHit = {
  documentId: "11111111-1111-4111-8111-111111111111",
  vaultId: "22222222-2222-4222-8222-222222222222",
  unitId: "33333333-3333-4333-8333-333333333333",
  unitType: "PARAGRAPH",
  document: {
    externalId: "doc-1",
    path: "managed/authorized.md",
    title: "SOURCE",
  },
  revision: "rev-1",
  title: "SOURCE",
  type: "claim",
  trust: "HUMAN_REVIEWED",
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  score: 1,
  reasons: ["test"],
  excerpt: "Lira approved the index.",
  citations: [],
};

describe("governed original SOURCE lookup remains request-authorized", () => {
  it("rejects out-of-scope vault/path before calling the external source port", async () => {
    const resolve = vi.fn(async () => null);
    const port: GovernedLayeredPropositionPort = { resolve };
    const scope = {
      principalId: "principal-A",
      spaceId: "space-A",
      pathAuthorizer: (path: string, vaultId: string) =>
        path === "managed/authorized.md" && vaultId === candidate.vaultId,
    };
    const bound = scopeGovernedLayeredPropositionPort(port, scope)!;
    await expect(
      bound.resolve({
        originalQuestion: "Who approved the index?",
        hit: { ...candidate, vaultId: "other-vault" },
      }),
    ).resolves.toBeNull();
    await expect(
      bound.resolve({
        originalQuestion: "Who approved the index?",
        hit: {
          ...candidate,
          document: { ...candidate.document, path: "private/secret.md" },
        },
      }),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    await bound.resolve({
      originalQuestion: "Who approved the index?",
      hit: candidate,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      originalQuestion: "Who approved the index?",
      hit: candidate,
      principalId: "principal-A",
      spaceId: "space-A",
    });
    expect(
      scopeGovernedLayeredPropositionPort(undefined, scope),
    ).toBeUndefined();
  });
});
