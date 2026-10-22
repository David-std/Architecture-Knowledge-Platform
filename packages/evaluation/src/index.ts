export interface RetrievalCaseResult {
  caseId: string;
  rankedDocumentIds: string[];
  goldDocumentIds: string[];
}

export * from "./dataset.js";
export * from "./benchmark.js";
export * from "./offline.js";
export * from "./curated.js";
export * from "./agent-ab.js";
export * from "./tool-ergonomics.js";
export * from "./capability-acceptance.js";
export * from "./agent-arena.js";
export * from "./competitive-arena.js";
export * from "./parity-exclusion.js";
export * from "./s2-source-span.js";
export * from "./s2-section-paired.js";
export * from "./s2-section-blind-review.js";
export * from "./s2-dual-axis.js";
export * from "./s2-writer-semantic-packets.js";
export * from "./s2-writer-semantic-audit.js";
export * from "./s2-writer-review-compat.js";
export * from "./s2-writer-passage-capture.js";
export * from "./s2-holdout-freeze.js";
export * from "./s2-owner-holdout.js";
export * from "./s2-owner-review-audit.js";
export * from "./s2-native-structured-writer.js";

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
