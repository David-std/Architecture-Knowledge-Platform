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
function rerankCandidateIdentity(
  hit: Pick<SearchHit, "documentId" | "unitId">,
): string {
  return hit.unitId ? `${hit.documentId}:${hit.unitId}` : hit.documentId;
}

export function rerankSearchHits(
  query: string,
  hits: readonly SearchHit[],
  reranker: SearchHitReranker,
): SearchHit[] {
  const ids = hits.map(rerankCandidateIdentity);
  if (new Set(ids).size !== ids.length) {
    throw new Error("RERANK_DUPLICATE_CANDIDATE_ID");
  }

  const preRankByCandidate = new Map(
    hits.map((hit, index) => [rerankCandidateIdentity(hit), index + 1]),
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
      (preRankByCandidate.get(rerankCandidateIdentity(left.hit)) ?? 0) -
        (preRankByCandidate.get(rerankCandidateIdentity(right.hit)) ?? 0) ||
      rerankCandidateIdentity(left.hit).localeCompare(
        rerankCandidateIdentity(right.hit),
      ),
  );

  const output = scored.map(({ hit, rerankScore, reason }, index) => ({
    ...hit,
    score: rerankScore,
    reasons: hit.reasons.includes(reason)
      ? [...hit.reasons]
      : [...hit.reasons, reason],
    rerankTrace: {
      reranker: reranker.id,
      preRank:
        preRankByCandidate.get(rerankCandidateIdentity(hit)) ?? index + 1,
      postRank: index + 1,
      preScore: hit.score,
      postScore: rerankScore,
    },
    ...(hit.retrievalTrace
      ? {
          retrievalTrace: {
            ...hit.retrievalTrace,
            rerank: {
              reranker: reranker.id,
              preRank:
                preRankByCandidate.get(rerankCandidateIdentity(hit)) ??
                index + 1,
              postRank: index + 1,
              preScore: hit.score,
              postScore: rerankScore,
            },
            finalSelectionReason: [...new Set([...hit.reasons, reason])].join(
              "; ",
            ),
          },
        }
      : {}),
  }));

  const outputIds = output.map(rerankCandidateIdentity);
  if (
    outputIds.length !== ids.length ||
    outputIds.some((id) => !preRankByCandidate.has(id))
  ) {
    throw new Error("RERANK_CANDIDATE_SET_CHANGED");
  }
  return output;
}

export type RerankFallbackWarning =
  "RERANKER_FALLBACK:INVALID_SCORE" | "RERANKER_FALLBACK:PROVIDER_ERROR";

export interface SafeRerankResult {
  hits: SearchHit[];
  warning?: RerankFallbackWarning;
}

function fallbackWarning(error: unknown): RerankFallbackWarning {
  return error instanceof Error && error.message === "RERANK_SCORE_INVALID"
    ? "RERANKER_FALLBACK:INVALID_SCORE"
    : "RERANKER_FALLBACK:PROVIDER_ERROR";
}

function markRerankFallback(
  hit: SearchHit,
  warning: RerankFallbackWarning,
): SearchHit {
  return {
    ...hit,
    warnings: [...new Set([...(hit.warnings ?? []), warning])],
    ...(hit.retrievalTrace
      ? {
          retrievalTrace: {
            ...hit.retrievalTrace,
            finalSelectionReason: [
              hit.retrievalTrace.finalSelectionReason,
              warning,
            ].join("; "),
          },
        }
      : {}),
  };
}

/**
 * Optional rerankers are not availability dependencies for retrieval.
 *
 * Provider/scorer failure preserves the already-authorized, truth-valid fused
 * order and records a stable warning. Duplicate baseline identities are an
 * internal invariant violation, not a provider degradation, and still fail
 * hard.
 */
export function rerankSearchHitsSafely(
  query: string,
  hits: readonly SearchHit[],
  reranker: SearchHitReranker,
): SafeRerankResult {
  try {
    return { hits: rerankSearchHits(query, hits, reranker) };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RERANK_DUPLICATE_CANDIDATE_ID"
    ) {
      throw error;
    }
    const warning = fallbackWarning(error);
    return {
      hits: hits.map((hit) => markRerankFallback(hit, warning)),
      warning,
    };
  }
}
