import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  BOUNDED_CROSS_ENCODER_RERANKER,
  rerankBoundedHitsWithCrossEncoder,
} from "../src/bounded-cross-encoder-rerank.js";

const doc = "11111111-1111-4111-8111-111111111111";
function hit(id: number): SearchHit {
  return {
    documentId: doc,
    unitId: `00000000-0000-4000-8000-00000000000${id}`,
    vaultId: "22222222-2222-4222-8222-222222222222",
    revision: "revision-1",
    title: "Technical source",
    excerpt: `Evidence passage ${id}`,
    score: 1 / id,
    reasons: ["lexical:unit-recall"],
    warnings: ["UNTRUSTED_RETRIEVED_CONTENT"],
    citations: [],
  } as unknown as SearchHit;
}
describe("bounded live candidate-only BGE reranking", () => {
  it("reorders top four only, leaves all remaining hits, fused scores and original identities untouched", async () => {
    const original = [hit(1), hit(2), hit(3), hit(4), hit(5)];
    let supplied: string[] = [];
    const result = await rerankBoundedHitsWithCrossEncoder(
      "Who approved the document?",
      original,
      {
        scoreMany: async (_query, passages) => {
          supplied = [...passages];
          return [0.1, 0.99, 0.7, 0.2];
        },
      },
      4,
    );
    expect(supplied).toEqual(original.slice(0, 4).map((item) => item.excerpt));
    expect(result.hits.map((item) => item.unitId)).toEqual([
      original[1]!.unitId,
      original[2]!.unitId,
      original[3]!.unitId,
      original[0]!.unitId,
      original[4]!.unitId,
    ]);
    expect(
      result.hits.find((item) => item.unitId === original[1]!.unitId)?.score,
    ).toBe(original[1]!.score);
    expect(result.hits[0]?.rerankTrace).toMatchObject({
      reranker: BOUNDED_CROSS_ENCODER_RERANKER,
      preRank: 2,
      postRank: 1,
    });
    expect(original[0]?.rerankTrace).toBeUndefined();
    expect(result.hits[4]).toBe(original[4]);
  });
  it("does not admit, filter or score by entailment: contradictory excerpts are retained", async () => {
    const hits = [hit(1), hit(2)];
    const result = await rerankBoundedHitsWithCrossEncoder(
      "Did Lira approve?",
      hits,
      { scoreMany: async () => [0.999, 0.998] },
    );
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((item) => item.score)).toEqual([1, 0.5]);
    expect(
      result.hits.every((item) =>
        item.warnings.includes("UNTRUSTED_RETRIEVED_CONTENT"),
      ),
    ).toBe(true);
  });
  it("preserves candidate order and records bounded failure without throwing on model outage", async () => {
    const hits = [hit(1), hit(2)];
    const result = await rerankBoundedHitsWithCrossEncoder("test", hits, {
      scoreMany: async () => {
        throw Error("MODEL_OFFLINE");
      },
    });
    expect(result.warning).toBe("RERANKER_FALLBACK:PROVIDER_ERROR");
    expect(result.hits.map((item) => item.unitId)).toEqual(
      hits.map((item) => item.unitId),
    );
    expect(result.hits[0]?.warnings).toContain(
      "RERANKER_FALLBACK:PROVIDER_ERROR",
    );
  });
  it.each([
    [NaN, 0.8],
    [2, 0.8],
    [-0.1, 0.8],
  ] as number[][])(
    "rejects invalid BGE relevance rather than using it as truth",
    async (a, b) => {
      const result = await rerankBoundedHitsWithCrossEncoder(
        "test",
        [hit(1), hit(2)],
        { scoreMany: async () => [a!, b!] },
      );
      expect(result.warning).toBe("RERANKER_FALLBACK:INVALID_SCORE");
    },
  );
  it("rejects candidate ID collisions before invoking the scorer", async () => {
    await expect(
      rerankBoundedHitsWithCrossEncoder("test", [hit(1), hit(1)], {
        scoreMany: async () => {
          throw Error("SHOULD_NOT_BE_CALLED");
        },
      }),
    ).rejects.toThrow("RERANK_DUPLICATE_CANDIDATE_ID");
  });
  it("rejects unbounded candidate budgets without invoking the model", async () => {
    await expect(
      rerankBoundedHitsWithCrossEncoder(
        "test",
        [hit(1)],
        { scoreMany: async () => [1] },
        9,
      ),
    ).rejects.toThrow("BGE_RERANK_CANDIDATE_BOUND_INVALID");
  });
  it("truncates model input and handles empty candidate pools without inference", async () => {
    const h = { ...hit(1), excerpt: "abc".repeat(1000) };
    const result = await rerankBoundedHitsWithCrossEncoder("test", [h], {
      scoreMany: async (_q, passages) => {
        expect(passages[0]?.length).toBe(1200);
        return [0.4];
      },
    });
    expect(result.hits).toHaveLength(1);
    expect(
      (
        await rerankBoundedHitsWithCrossEncoder("test", [], {
          scoreMany: async () => {
            throw Error("UNEXPECTED");
          },
        })
      ).hits,
    ).toEqual([]);
  });
});
