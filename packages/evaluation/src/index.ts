export interface RetrievalCaseResult {
  caseId: string;
  rankedDocumentIds: string[];
  goldDocumentIds: string[];
}

export interface RetrievalMetrics {
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  hit: boolean;
}

export function scoreRetrieval(
  result: RetrievalCaseResult,
  k: number,
): RetrievalMetrics {
  const top = result.rankedDocumentIds.slice(0, k);
  const gold = new Set(result.goldDocumentIds);
  const relevant = top.filter((id) => gold.has(id));
  const first = top.findIndex((id) => gold.has(id));

  return {
    recallAtK: gold.size === 0 ? 1 : relevant.length / gold.size,
    precisionAtK: top.length === 0 ? 0 : relevant.length / top.length,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    hit: relevant.length > 0,
  };
}
