import type { SearchHit } from "@akp/contracts";

/**
 * Model scorer injected after authorization, revision and trust filtering.
 * It ranks the (question, passage) pair; its score is NOT entailment.
 */
export interface BoundedCrossEncoderPort {
  scoreMany(query: string, passages: readonly string[]): Promise<number[]>;
}

export const BOUNDED_CROSS_ENCODER_RERANKER =
  "local-bge-reranker-v2-m3-relevance" as const;

export interface BoundedCrossEncoderRerankResult {
  hits: SearchHit[];
  evaluatedCandidates: number;
  warning?:
    "RERANKER_FALLBACK:PROVIDER_ERROR" | "RERANKER_FALLBACK:INVALID_SCORE";
}

function identity(hit: SearchHit): string {
  return hit.unitId ? `${hit.documentId}:${hit.unitId}` : hit.documentId;
}

/**
 * Reorder only the first 1..8 ALREADY AUTHORIZED hits.
 *
 * The remainder remains in its existing fused order, and no hit is dropped,
 * promoted as evidence, fabricated or given a normalized BGE score as its
 * retrieval score. The Reader continues to judge full proposition support.
 */
export async function rerankBoundedHitsWithCrossEncoder(
  query: string,
  hits: readonly SearchHit[],
  scorer: BoundedCrossEncoderPort,
  maxCandidates = 4,
): Promise<BoundedCrossEncoderRerankResult> {
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > 8
  ) {
    throw new Error("BGE_RERANK_CANDIDATE_BOUND_INVALID");
  }
  const identities = hits.map(identity);
  if (new Set(identities).size !== identities.length) {
    throw new Error("RERANK_DUPLICATE_CANDIDATE_ID");
  }
  if (hits.length === 0) return { hits: [], evaluatedCandidates: 0 };
  const evaluatedCandidates = Math.min(hits.length, maxCandidates);
  const candidates = hits.slice(0, evaluatedCandidates);
  try {
    // Never send whole vaults or parent context to a reranker.
    const scores = await scorer.scoreMany(
      query,
      candidates.map((hit) => hit.excerpt.slice(0, 1_200)),
    );
    if (
      scores.length !== evaluatedCandidates ||
      scores.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    ) {
      throw new Error("RERANK_SCORE_INVALID");
    }
    const ordered = candidates
      .map((hit, index) => ({
        hit,
        rank: index + 1,
        relevance: scores[index]!,
      }))
      .sort(
        (left, right) =>
          right.relevance - left.relevance || left.rank - right.rank,
      );
    const reordered = [
      ...ordered.map(({ hit, rank }, index): SearchHit => {
        const postRank = index + 1;
        const reason = "rerank:local-bge-relevance-only";
        const reasons = hit.reasons.includes(reason)
          ? hit.reasons
          : [...hit.reasons, reason];
        return {
          ...hit,
          // Preserve fused score; BGE sigmoid probabilities are not comparable
          // with RRF or BM25, nor with evidence entailment.
          reasons,
          rerankTrace: {
            reranker: BOUNDED_CROSS_ENCODER_RERANKER,
            preRank: rank,
            postRank,
            preScore: hit.score,
            postScore: hit.score,
          },
          ...(hit.retrievalTrace
            ? {
                retrievalTrace: {
                  ...hit.retrievalTrace,
                  rerank: {
                    reranker: BOUNDED_CROSS_ENCODER_RERANKER,
                    preRank: rank,
                    postRank,
                    preScore: hit.score,
                    postScore: hit.score,
                  },
                  finalSelectionReason: reasons.join("; ").slice(0, 8_192),
                },
              }
            : {}),
        };
      }),
      ...hits.slice(evaluatedCandidates),
    ];
    if (
      reordered.length !== hits.length ||
      new Set(reordered.map(identity)).size !== hits.length ||
      reordered.some((hit) => !identities.includes(identity(hit)))
    ) {
      throw new Error("RERANK_CANDIDATE_SET_CHANGED");
    }
    return { hits: reordered, evaluatedCandidates };
  } catch (error) {
    const warning =
      error instanceof Error && error.message === "RERANK_SCORE_INVALID"
        ? ("RERANKER_FALLBACK:INVALID_SCORE" as const)
        : ("RERANKER_FALLBACK:PROVIDER_ERROR" as const);
    return {
      hits: hits.map((hit) => ({
        ...hit,
        warnings: [...new Set([...(hit.warnings ?? []), warning])],
      })),
      evaluatedCandidates,
      warning,
    };
  }
}
