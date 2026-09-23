import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  DETERMINISTIC_LEXICAL_RERANKER,
  deterministicLexicalReranker,
  rerankSearchHits,
  rerankSearchHitsSafely,
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
        retrievalTrace: {
          authorization: {
            decision: "ALLOW",
            spaceId: "00000000-0000-4000-8000-000000000088",
            vaultId: "00000000-0000-4000-8000-000000000099",
            pathRestricted: true,
          },
          truth: {
            state: "SUPPORTED",
            consistency: "STRICT",
            revisionHash: "a".repeat(64),
            capturedAt: "2026-09-20T00:00:00.000Z",
          },
          temporal: {
            lifecycle: "ACTIVE",
            refreshStatus: "CURRENT",
          },
          contributions: [
            {
              channel: "lexical",
              rank: 2,
              channelWeight: 1,
              reason: "lexical:title",
              rawScore: 0.8,
              candidateRevision: "corpus-1",
            },
          ],
          fusion: { score: 1, reasons: ["rrf"] },
          finalSelectionReason: "rrf",
        },
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
      expect(candidate.rerankTrace?.preScore).toBeGreaterThan(0);
      expect(candidate.rerankTrace?.postScore).toBe(candidate.score);
    }
    expect(output[0]?.retrievalTrace?.rerank).toMatchObject({
      reranker: DETERMINISTIC_LEXICAL_RERANKER,
      preRank: 2,
      postRank: 1,
      preScore: 1,
    });
    expect(output[0]?.retrievalTrace?.rerank?.postScore).toBe(output[0]?.score);
    expect(output[0]?.retrievalTrace?.finalSelectionReason).toContain(
      "deterministic-lexical-rerank",
    );
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

  it("falls back to fused order when an optional reranker returns an invalid score", () => {
    const first = hit(
      "00000000-0000-4000-8000-000000000005",
      "Baseline first",
      "Baseline first",
      {
        retrievalTrace: {
          authorization: {
            decision: "ALLOW",
            spaceId: "00000000-0000-4000-8000-000000000088",
            vaultId: "00000000-0000-4000-8000-000000000099",
            pathRestricted: false,
          },
          truth: {
            state: "SUPPORTED",
            consistency: "STRICT",
            revisionHash: "b".repeat(64),
            capturedAt: "2026-09-21T00:00:00.000Z",
          },
          temporal: {
            lifecycle: "ACTIVE",
            refreshStatus: "CURRENT",
          },
          contributions: [
            {
              channel: "lexical",
              rank: 1,
              channelWeight: 1,
              reason: "lexical:baseline",
            },
          ],
          fusion: { score: 1, reasons: ["rrf"] },
          finalSelectionReason: "rrf",
        },
      },
    );
    const second = hit(
      "00000000-0000-4000-8000-000000000006",
      "Baseline second",
      "Baseline second",
    );
    const invalid: SearchHitReranker = {
      id: DETERMINISTIC_LEXICAL_RERANKER,
      score: () => ({ delta: Number.NaN, reason: "invalid" }),
    };

    const result = rerankSearchHitsSafely("baseline", [first, second], invalid);

    expect(result.warning).toBe("RERANKER_FALLBACK:INVALID_SCORE");
    expect(result.hits.map((candidate) => candidate.documentId)).toEqual([
      first.documentId,
      second.documentId,
    ]);
    expect(result.hits.map((candidate) => candidate.score)).toEqual([1, 1]);
    expect(result.hits[0]?.warnings).toContain(
      "RERANKER_FALLBACK:INVALID_SCORE",
    );
    expect(result.hits[0]?.retrievalTrace?.rerank).toBeUndefined();
    expect(result.hits[0]?.retrievalTrace?.finalSelectionReason).toContain(
      "RERANKER_FALLBACK:INVALID_SCORE",
    );
    expect(first.warnings).not.toContain("RERANKER_FALLBACK:INVALID_SCORE");
  });

  it("sanitizes provider exceptions and preserves the fused baseline", () => {
    const baseline = [
      hit(
        "00000000-0000-4000-8000-000000000007",
        "Provider baseline",
        "Provider baseline",
      ),
    ];
    const unavailable: SearchHitReranker = {
      id: DETERMINISTIC_LEXICAL_RERANKER,
      score: () => {
        throw new Error("https://secret-provider.local/api timeout token=abc");
      },
    };

    const result = rerankSearchHitsSafely(
      "provider unavailable",
      baseline,
      unavailable,
    );

    expect(result.warning).toBe("RERANKER_FALLBACK:PROVIDER_ERROR");
    expect(result.hits.map((candidate) => candidate.documentId)).toEqual(
      baseline.map((candidate) => candidate.documentId),
    );
    expect(JSON.stringify(result)).not.toContain("secret-provider");
    expect(JSON.stringify(result)).not.toContain("token=abc");
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
