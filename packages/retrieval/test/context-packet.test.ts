import { describe, expect, it } from "vitest";
import {
  buildContextPacket,
  contextBudgetForIntent,
} from "../src/context-packet.js";

const baseHit = {
  documentId: "11111111-1111-4111-8111-111111111111",
  vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
        spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vaultIds: [],
        federated: false,
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
    expect(packet.sections[0]).toMatchObject({
      documentRevision: "abc",
      sourceOrEvidenceIds: ["source:cqrs"],
      selectionReason: "gold",
    });
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
        spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vaultIds: [],
        federated: false,
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

  it("uses bounded task-specific budgets", () => {
    expect(contextBudgetForIntent("EXACT_LOOKUP")).toBe(3000);
    expect(contextBudgetForIntent("GLOBAL_SYNTHESIS")).toBe(12000);
    expect(contextBudgetForIntent("CONCEPTUAL", 100_000)).toBe(32000);
    expect(contextBudgetForIntent("CONCEPTUAL", 1)).toBe(256);
  });
});
