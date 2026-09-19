import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  DETERMINISTIC_LEXICAL_RERANKER,
  deterministicLexicalReranker,
  rerankSearchHits,
  type SearchHitReranker,
} from "../src/rerank.js";

function hit(
  documentId: string,
  title: string,
  excerpt: string,
  overrides: Partial<SearchHit> = {},
): SearchHit {
  return {
    documentId,
    vaultId: "00000000-0000-4000-8000-000000000099",
    document: {
      externalId: title.toUpperCase().replaceAll(" ", "-"),
      path: `docs/${documentId}.md`,
      title,
    },
    revision: "corpus-1",
    title,
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["rrf"],
    excerpt,
    citations: [`source:${documentId}`],
    warnings: ["CONFLICT_METADATA_PRESERVED"],
    ...overrides,
  };
}

function protectedMetadata(value: SearchHit) {
  return {
    documentId: value.documentId,
    vaultId: value.vaultId,
    document: value.document,
    revision: value.revision,
    type: value.type,
    trust: value.trust,
    lifecycle: value.lifecycle,
    refreshStatus: value.refreshStatus,
    citations: value.citations,
    warnings: value.warnings,
    fusionContributions: value.fusionContributions,
    graphProvenance: value.graphProvenance,
  };
}

describe("safe search hit reranking", () => {
  it("only reorders the authorized input set and preserves sensitive metadata", () => {
    const first = hit(
      "00000000-0000-4000-8000-000000000001",
      "General architecture",
      "A broad architecture overview.",
    );
    const second = hit(
      "00000000-0000-4000-8000-000000000002",
      "Retry policy",
      "Retry policy and retry backoff guidance.",
      {
        trust: "ATTESTED",
        citations: ["evidence:retry-policy"],
        warnings: ["DISPUTED_SUPPORT_VISIBLE"],
      },
    );
    const input = [first, second];
    const before = new Map(
      input.map((candidate) => [
        candidate.documentId,
        protectedMetadata(candidate),
      ]),
    );

    const output = rerankSearchHits(
      "retry policy",
      input,
      deterministicLexicalReranker,
    );

    expect(output.map((candidate) => candidate.documentId)).toEqual([
      second.documentId,
      first.documentId,
    ]);
    expect(new Set(output.map((candidate) => candidate.documentId))).toEqual(
      new Set(input.map((candidate) => candidate.documentId)),
    );
    for (const candidate of output) {
      expect(protectedMetadata(candidate)).toEqual(
        before.get(candidate.documentId),
      );
      expect(candidate.rerankTrace).toMatchObject({
        reranker: DETERMINISTIC_LEXICAL_RERANKER,
        postRank: output.indexOf(candidate) + 1,
      });
      expect(candidate.rerankTrace?.preRank).toBeGreaterThan(0);
    }
    expect(first.rerankTrace).toBeUndefined();
    expect(second.rerankTrace).toBeUndefined();
  });

  it("rejects duplicate identities before scoring", () => {
    const candidate = hit(
      "00000000-0000-4000-8000-000000000003",
      "Duplicate",
      "Duplicate candidate",
    );
    expect(() =>
      rerankSearchHits(
        "duplicate",
        [candidate, { ...candidate }],
        deterministicLexicalReranker,
      ),
    ).toThrow("RERANK_DUPLICATE_CANDIDATE_ID");
  });

  it("rejects invalid scorer output instead of corrupting rank state", () => {
    const invalid: SearchHitReranker = {
      id: DETERMINISTIC_LEXICAL_RERANKER,
      score: () => ({ delta: Number.NaN, reason: "invalid" }),
    };
    expect(() =>
      rerankSearchHits(
        "invalid",
        [
          hit(
            "00000000-0000-4000-8000-000000000004",
            "Invalid",
            "Invalid scorer fixture",
          ),
        ],
        invalid,
      ),
    ).toThrow("RERANK_SCORE_INVALID");
  });
});
