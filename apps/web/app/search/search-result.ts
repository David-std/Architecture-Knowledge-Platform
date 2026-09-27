export type SearchRetrievalOutcome =
  | "SUPPORTED"
  | "EXPLORATORY_ONLY"
  | "NO_CANDIDATES";

export interface SearchResultPresentationInput {
  retrievalOutcome?: SearchRetrievalOutcome;
  hits: readonly unknown[];
  exploratoryHits?: readonly unknown[];
}

export function searchResultPresentation(
  result: SearchResultPresentationInput,
): {
  supportedCount: number;
  exploratoryCount: number;
  outcome: SearchRetrievalOutcome;
} {
  const exploratoryCount = result.exploratoryHits?.length ?? 0;
  const outcome =
    result.retrievalOutcome ??
    (result.hits.length > 0
      ? "SUPPORTED"
      : exploratoryCount > 0
        ? "EXPLORATORY_ONLY"
        : "NO_CANDIDATES");
  return {
    supportedCount: result.hits.length,
    exploratoryCount,
    outcome,
  };
}
