import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import { retrieveExistingKnowledgeCandidates } from "../src/knowledge-compilation.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_SHA256 = "a".repeat(64);
const DOCUMENT_A = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_B = "44444444-4444-4444-8444-444444444444";
const DOCUMENT_C = "55555555-5555-4555-8555-555555555555";

function candidate(
  id: string,
  title: string,
  score: number,
  reason: string,
) {
  return {
    document_id: id,
    external_id: `EXT-${id.slice(0, 4)}`,
    path: `20-knowledge/${id}.md`,
    title,
    type: "concept",
    lifecycle: "ACTIVE",
    trust_tier: "HUMAN_REVIEWED",
    current_revision: "managed:test",
    content_excerpt: `${title} grounded excerpt`,
    score,
    reason,
  };
}

describe("compiler existing-knowledge retrieval", () => {
  it("fuses source identity, lexical, semantic-neighbor and graph candidates inside one vault", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          candidate(DOCUMENT_A, "Previous source title", 120, "exact:source-id"),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          candidate(
            DOCUMENT_B,
            "Revision invalidation",
            0.88,
            "semantic:neighbor",
          ),
        ],
      })
      .mockResolvedValueOnce({
        rows: [candidate(DOCUMENT_C, "Cache workflow", 2, "graph:requires")],
      });
    const db = { pool: { query } } as unknown as Postgres;

    const result = await retrieveExistingKnowledgeCandidates(db, {
      spaceId: SPACE_ID,
      vaultId: VAULT_ID,
      sourceId: SOURCE_ID,
      sourceSha256: SOURCE_SHA256,
      title: "Renamed cache policy",
      evidenceExcerpt: "Invalidate cached knowledge when revision changes.",
      vectorEnabled: true,
      limit: 8,
    });

    expect(result.channels).toEqual(["exact", "lexical", "semantic", "graph"]);
    expect(result.warnings).toEqual([]);
    expect(result.candidates.map((entry) => entry.documentId)).toEqual([
      DOCUMENT_A,
      DOCUMENT_C,
      DOCUMENT_B,
    ]);
    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) {
      const parameters = call[1] as unknown[];
      expect(parameters[0]).toBe(SPACE_ID);
      expect(parameters[1]).toBe(VAULT_ID);
    }
    const lexicalSql = String(query.mock.calls[0]?.[0]);
    const lexicalParameters = query.mock.calls[0]?.[1] as unknown[];
    expect(lexicalSql).toContain("frontmatter->>'source_id'=$7");
    expect(lexicalSql).toContain("frontmatter->>'source_sha256'=$8");
    expect(lexicalParameters[6]).toBe(SOURCE_ID);
    expect(lexicalParameters[7]).toBe(SOURCE_SHA256);
  });

  it("reports semantic degradation explicitly instead of pretending it ran", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [candidate(DOCUMENT_A, "Cache policy", 80, "lexical:terms")],
      })
      .mockResolvedValueOnce({ rows: [] });
    const db = { pool: { query } } as unknown as Postgres;

    const result = await retrieveExistingKnowledgeCandidates(db, {
      spaceId: SPACE_ID,
      vaultId: VAULT_ID,
      title: "Cache policy",
      evidenceExcerpt: "Invalidate cached knowledge when revision changes.",
      vectorEnabled: false,
    });

    expect(result.channels).toEqual(["exact", "lexical"]);
    expect(result.warnings).toEqual(["COMPILER_SEMANTIC_RETRIEVAL_DISABLED"]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
