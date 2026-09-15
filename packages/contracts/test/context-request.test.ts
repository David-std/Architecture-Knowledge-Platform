import { describe, expect, it } from "vitest";
import { ContextRequest } from "../src/index.js";

const base = {
  query: "bounded context",
  spaceId: "00000000-0000-0000-0000-000000000003",
};

describe("ContextRequest", () => {
  it("defaults to the full packet and accepts a bounded compact request", () => {
    expect(ContextRequest.parse(base).packetMode).toBe("FULL_CONTEXT_PACKET");
    expect(
      ContextRequest.parse({
        ...base,
        packetMode: "COMPACT_AGENT_PACKET",
        maxTokens: 256,
      }),
    ).toMatchObject({ packetMode: "COMPACT_AGENT_PACKET", maxTokens: 256 });
  });

  it.each([255, 32001, 512.5, "512"])(
    "rejects an invalid maxTokens value: %s",
    (maxTokens) => {
      expect(ContextRequest.safeParse({ ...base, maxTokens }).success).toBe(
        false,
      );
    },
  );

  it("rejects an unknown packet mode", () => {
    expect(
      ContextRequest.safeParse({ ...base, packetMode: "SHORT" }).success,
    ).toBe(false);
  });
});
