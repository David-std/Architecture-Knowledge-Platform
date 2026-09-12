import { describe, expect, it, vi } from "vitest";
import { CompilationPlan } from "@akp/compiler";
import type { Postgres } from "@akp/postgres";
import { evaluateCompilationProbes } from "../src/compilation-probes.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const EVIDENCE_ID = "44444444-4444-4444-8444-444444444444";

function plan(content: string) {
  return CompilationPlan.parse({
    sourceId: SOURCE_ID,
    corpusRevision: "managed:test",
    disposition: "NEW",
    summary: "Grounded rule proposal.",
    proposedChanges: [
      {
        path: "20-knowledge/generated/rule/cache.md",
        operation: "CREATE",
        content,
        reasons: ["Grounded in source evidence."],
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    impactedDocumentIds: [],
    conflicts: [],
    probes: [
      {
        question: "When should cached material be invalidated?",
        criticality: "CRITICAL",
        evidenceIds: [EVIDENCE_ID],
      },
    ],
  });
}

describe("compilation probes", () => {
  it("passes a critical probe only when scoped evidence supports the linked draft", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: EVIDENCE_ID,
          excerpt:
            "Invalidate cached material when the authoritative revision changes.",
        },
      ],
    });
    const db = { pool: { query } } as unknown as Postgres;

    const [result] = await evaluateCompilationProbes(db, {
      plan: plan(
        "# Cache invalidation\n\nInvalidate cached material when the authoritative revision changes.",
      ),
      spaceId: SPACE_ID,
      vaultId: VAULT_ID,
      sourceId: SOURCE_ID,
    });

    expect(result).toMatchObject({
      passed: true,
      method: "DRAFT_EVIDENCE_RETRIEVAL",
      matchedEvidenceIds: [EVIDENCE_ID],
    });
    expect(result?.supportScore).toBeGreaterThan(0);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("vault_id=$2"), [
      SPACE_ID,
      VAULT_ID,
      SOURCE_ID,
      [EVIDENCE_ID],
    ]);
  });

  it("fails closed when the linked draft has no textual support", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: EVIDENCE_ID,
          excerpt:
            "Invalidate cached material when the authoritative revision changes.",
        },
      ],
    });
    const db = { pool: { query } } as unknown as Postgres;

    const [result] = await evaluateCompilationProbes(db, {
      plan: plan("# Unrelated\n\nA completely different statement about ocean tides."),
      spaceId: SPACE_ID,
      vaultId: VAULT_ID,
      sourceId: SOURCE_ID,
    });

    expect(result).toMatchObject({
      passed: false,
      method: "DRAFT_EVIDENCE_RETRIEVAL",
      matchedEvidenceIds: [],
    });
  });

  it("fails when the evidence row is outside the scoped query result", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { pool: { query } } as unknown as Postgres;

    const [result] = await evaluateCompilationProbes(db, {
      plan: plan(
        "# Cache invalidation\n\nInvalidate cached material when revision changes.",
      ),
      spaceId: SPACE_ID,
      vaultId: VAULT_ID,
      sourceId: SOURCE_ID,
    });

    expect(result?.passed).toBe(false);
    expect(result?.matchedEvidenceIds).toEqual([]);
  });
});
