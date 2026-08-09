import { describe, expect, it } from "vitest";
import { buildContextPacket } from "../src/context-packet.js";

const baseHit = {
  documentId: "11111111-1111-4111-8111-111111111111",
  revision: "abc",
  title: "CQRS",
  type: "architecture",
  trust: "HUMAN_REVIEWED" as const,
  lifecycle: "ACTIVE" as const,
  score: 1,
  reasons: ["gold"],
  excerpt: "CQRS",
  citations: ["source:cqrs"],
};

describe("buildContextPacket", () => {
  it("respects the token budget and hashes the result", () => {
    const packet = buildContextPacket({
      request: {
        query: "cqrs",
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 20,
      },
      intent: "architecture-selection",
      corpusRevision: "deadbeef",
      maxTokens: 30,
      candidates: [
        { hit: baseHit, content: "short content", kind: "rule" },
        {
          hit: {
            ...baseHit,
            documentId: "22222222-2222-4222-8222-222222222222",
          },
          content: "x".repeat(1000),
          kind: "source",
        },
      ],
    });

    expect(packet.sections).toHaveLength(1);
    expect(packet.budget.usedTokens).toBeLessThanOrEqual(
      packet.budget.maxTokens,
    );
    expect(packet.continuations).toHaveLength(1);
    expect(packet.continuations[0]?.handle).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.packetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an explicit no-answer packet when no supported candidate exists", () => {
    const packet = buildContextPacket({
      request: {
        query: "nonexistent architecture assertion",
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 20,
      },
      intent: "SOURCE_VERIFICATION",
      corpusRevision: "deadbeef",
      maxTokens: 500,
      candidates: [],
      gaps: ["No source-backed material matched the request."],
    });

    expect(packet.status).toBe("INSUFFICIENT_KNOWLEDGE");
    expect(packet.sections).toEqual([]);
    expect(packet.gaps).toEqual([
      "No source-backed material matched the request.",
    ]);
    expect(packet.requiredActions).toContain(
      "Do not claim vault authority without evidence.",
    );
  });
});
