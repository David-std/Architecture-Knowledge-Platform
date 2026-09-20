import { describe, expect, it } from "vitest";
import { FederationFanoutRequest } from "../src/index.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const PEER_ID = "33333333-3333-4333-8333-333333333333";

describe("federation fanout contract", () => {
  it("bounds peer fanout and forbids recursive local federation", () => {
    const peer = {
      peerId: PEER_ID,
      query: {
        schemaVersion: 1 as const,
        scope: { spaceId: SPACE_ID, vaultIds: [VAULT_ID] },
        request: { query: "remote cache rule" },
        budget: {
          maxResults: 10,
          maxWallMs: 1_000,
          maxResponseBytes: 50_000,
        },
        revisionPreferences: [],
      },
    };
    expect(
      FederationFanoutRequest.parse({
        schemaVersion: 1,
        local: {
          query: "local cache rule",
          spaceId: SPACE_ID,
          vaultIds: [VAULT_ID],
        },
        peers: [peer],
      }).peers,
    ).toHaveLength(1);

    expect(
      FederationFanoutRequest.safeParse({
        schemaVersion: 1,
        local: {
          query: "recursive",
          spaceId: SPACE_ID,
          vaultIds: [VAULT_ID],
          federated: true,
        },
        peers: [],
      }).success,
    ).toBe(false);

    expect(
      FederationFanoutRequest.safeParse({
        schemaVersion: 1,
        local: {
          query: "duplicate peers",
          spaceId: SPACE_ID,
          vaultIds: [VAULT_ID],
        },
        peers: [peer, peer],
      }).success,
    ).toBe(false);
  });
});
