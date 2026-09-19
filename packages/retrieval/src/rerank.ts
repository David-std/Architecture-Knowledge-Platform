import type { SearchHit } from "@akp/contracts";

export const DETERMINISTIC_LEXICAL_RERANKER =
  "deterministic-lexical-v1" as const;

export type SupportedReranker = typeof DETERMINISTIC_LEXICAL_RERANKER;

export interface RerankScore {
  /** Secondary score only. The fused retrieval score remains the primary base. */
  delta: number;
  reason: string;
}

export interface SearchHitReranker {
  id: SupportedReranker;
  score(query: string, hit: Readonly<SearchHit>): RerankScore;
}

function normalizedTerms(query: string): Set<string> {
  return new Set(
    query
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^\p{Letter}\p{Number}]+/u)
      .filter((term) => term.length >= 3),
  );
}

export const deterministicLexicalReranker: SearchHitReranker = {
  id: DETERMINISTIC_LEXICAL_RERANKER,
  score(query, hit) {
    const terms = normalizedTerms(query);
    const haystack = `${hit.title} ${hit.excerpt}`
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
    const overlap = [...terms].filter((term) => haystack.includes(term)).length;
    return {
      delta: overlap * 0.001,
      reason: "deterministic-lexical-rerank",
    };
  },
};

export function resolveSearchHitReranker(
  id: string | undefined,
): SearchHitReranker | null {
  if (!id) return null;
  if (id === DETERMINISTIC_LEXICAL_RERANKER) {
    return deterministicLexicalReranker;
  }
  throw new Error(`RERANKER_UNSUPPORTED:${id}`);
}

/**
 * Reorder an already-authorized/truth-valid result set.
 *
 * The scorer cannot return candidate objects, so it cannot introduce a new
 * document or recover one that was filtered earlier. Every output object is
 * derived from the corresponding input hit and therefore preserves trust,
 * lifecycle, citations, warnings, graph provenance and conflict-relevant
 * metadata. Only score, reasons and rerankTrace are extended.
 */
export function rerankSearchHits(
  query: string,
  hits: readonly SearchHit[],
  reranker: SearchHitReranker,
): SearchHit[] {
  const ids = hits.map((hit) => hit.documentId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("RERANK_DUPLICATE_CANDIDATE_ID");
  }

  const preRankByDocument = new Map(
    hits.map((hit, index) => [hit.documentId, index + 1]),
  );
  const scored = hits.map((hit) => {
    const result = reranker.score(query, hit);
    if (
      !Number.isFinite(result.delta) ||
      typeof result.reason !== "string" ||
      result.reason.trim() === ""
    ) {
      throw new Error("RERANK_SCORE_INVALID");
    }
    return {
      hit,
      rerankScore: hit.score + result.delta,
      reason: result.reason.trim(),
    };
  });

  scored.sort(
    (left, right) =>
      right.rerankScore - left.rerankScore ||
      (preRankByDocument.get(left.hit.documentId) ?? 0) -
        (preRankByDocument.get(right.hit.documentId) ?? 0) ||
      left.hit.documentId.localeCompare(right.hit.documentId),
  );

  const output = scored.map(({ hit, rerankScore, reason }, index) => ({
    ...hit,
    score: rerankScore,
    reasons: hit.reasons.includes(reason)
      ? [...hit.reasons]
      : [...hit.reasons, reason],
    rerankTrace: {
      reranker: reranker.id,
      preRank: preRankByDocument.get(hit.documentId) ?? index + 1,
      postRank: index + 1,
    },
  }));

  const outputIds = output.map((hit) => hit.documentId);
  if (
    outputIds.length !== ids.length ||
    outputIds.some((id) => !preRankByDocument.has(id))
  ) {
    throw new Error("RERANK_CANDIDATE_SET_CHANGED");
  }
  return output;
}
