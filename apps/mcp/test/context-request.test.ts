import { describe, expect, it } from "vitest";
import { ContextRequest } from "@akp/contracts";
import { McpContextRequest } from "../src/context-request.js";

const base = {
  query: "dependency inversion architecture",
  spaceId: "00000000-0000-0000-0000-000000000003",
  vaultIds: ["11111111-1111-1111-1111-111111111111"],
};

describe("MCP context request defaults", () => {
  it("defaults to the compact projection and the agent budget", () => {
    const parsed = McpContextRequest.parse(base);
    expect(parsed.packetMode).toBe("COMPACT_AGENT_PACKET");
    expect(parsed.maxTokens).toBe(6_000);
  });

  it("still honours an explicit full packet request", () => {
    const parsed = McpContextRequest.parse({
      ...base,
      packetMode: "FULL_CONTEXT_PACKET",
      maxTokens: 12_000,
    });
    expect(parsed.packetMode).toBe("FULL_CONTEXT_PACKET");
    expect(parsed.maxTokens).toBe(12_000);
  });

  it("keeps the REST default distinct so the override stays deliberate", () => {
    expect(ContextRequest.parse(base).packetMode).toBe("FULL_CONTEXT_PACKET");
  });

  it("carries every field of the shared contract", () => {
    // The MCP schema overrides defaults only; a field added to the shared
    // contract must reach this tool without another manual edit.
    expect(Object.keys(McpContextRequest.shape).sort()).toEqual(
      Object.keys(ContextRequest.shape).sort(),
    );
  });
});
