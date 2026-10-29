import { describe, expect, it } from "vitest";
import { assertAuthorizedRetrievalRequest } from "../src/routes/search.js";

const vaultA = "11111111-1111-4111-8111-111111111111";
const vaultB = "22222222-2222-4222-8222-222222222222";
const space = "33333333-3333-4333-8333-333333333333";

describe("S2.1 shared typed authorized retrieval boundary", () => {
  const authority = { spaceId: space, vaultIds: [vaultA] };
  const query = {
    spaceId: space,
    vaultId: vaultA,
    vaultIds: [],
    federated: false,
  };

  it("allows the exact scoped request reused by Search and Context", () => {
    expect(() =>
      assertAuthorizedRetrievalRequest(query, authority),
    ).not.toThrow();
  });

  it("fails closed before provider/SQL on foreign vault, space or widened federation", () => {
    for (const request of [
      { ...query, spaceId: vaultB },
      { ...query, vaultId: vaultB },
      { ...query, vaultIds: [vaultB], federated: true },
      { ...query, vaultIds: [vaultA, vaultB], federated: true },
      { ...query, vaultId: undefined, vaultIds: [vaultB] },
    ]) {
      expect(() =>
        assertAuthorizedRetrievalRequest(request, authority),
      ).toThrow("RETRIEVAL_AUTHORIZED_SCOPE_MISMATCH");
    }
  });

  it("does not permit implicit fanout across multiple authorized vaults", () => {
    expect(() =>
      assertAuthorizedRetrievalRequest(
        { ...query, vaultId: undefined, vaultIds: [vaultA, vaultB] },
        { spaceId: space, vaultIds: [vaultA, vaultB] },
      ),
    ).toThrow("RETRIEVAL_AUTHORIZED_SCOPE_MISMATCH");
    expect(() =>
      assertAuthorizedRetrievalRequest(
        {
          ...query,
          vaultId: undefined,
          vaultIds: [vaultA, vaultB],
          federated: true,
        },
        { spaceId: space, vaultIds: [vaultA, vaultB] },
      ),
    ).not.toThrow();
  });

  it("rejects empty authority even if input has no explicit vault", () => {
    expect(() =>
      assertAuthorizedRetrievalRequest(
        { ...query, vaultId: undefined },
        { spaceId: space, vaultIds: [] },
      ),
    ).toThrow("RETRIEVAL_AUTHORIZED_SCOPE_MISMATCH");
  });
});
