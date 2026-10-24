import { describe, expect, it } from "vitest";
import { ContextRequest, IngestRequest } from "../src/index.js";

const developmentSpaceId = "00000000-0000-0000-0000-000000000003";
const developmentVaultId = "00000000-0000-0000-0000-000000000004";

describe("persisted identifier compatibility with Zod 4", () => {
  it("accepts existing PostgreSQL GUID identities without rewriting migrations", () => {
    expect(
      ContextRequest.safeParse({
        query: "authorized historical knowledge",
        spaceId: developmentSpaceId,
      }).success,
    ).toBe(true);
    expect(
      IngestRequest.safeParse({
        spaceId: developmentSpaceId,
        vaultId: developmentVaultId,
        sourceUri: "/allowed/source.pdf",
      }).success,
    ).toBe(true);
  });

  it.each([
    "invalid",
    "00000000-0000-0000-0000-00000000000g",
    "00000000000000000000000000000003",
  ])("still rejects a malformed GUID: %s", (spaceId) => {
    expect(
      ContextRequest.safeParse({
        query: "unauthorized malformed identity",
        spaceId,
      }).success,
    ).toBe(false);
  });
});
