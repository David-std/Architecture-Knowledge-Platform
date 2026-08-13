export interface RetrievalCaseResult {
  caseId: string;
  rankedDocumentIds: string[];
  goldDocumentIds: string[];
}

export * from "./dataset.js";
export * from "./benchmark.js";
export * from "./offline.js";

export interface RetrievalMetrics {
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
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
  const dcg = top.reduce(
    (sum, id, index) => sum + (gold.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealHits = Math.min(gold.size, k);
  const idealDcg = Array.from({ length: idealHits }).reduce<number>(
    (sum, _value, index) => sum + 1 / Math.log2(index + 2),
    0,
  );

  return {
    recallAtK: gold.size === 0 ? 1 : relevant.length / gold.size,
    precisionAtK: top.length === 0 ? 0 : relevant.length / top.length,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    ndcgAtK: idealDcg === 0 ? 1 : dcg / idealDcg,
    hit: relevant.length > 0,
  };
}
