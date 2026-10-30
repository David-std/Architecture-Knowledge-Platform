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
export * from "./s2-retrieved-writer-bridge.js";
export * from "./s2-authenticated-http-writer-bridge.js";
export * from "./s2-exact-quote-attribution.js";
export * from "./s2-semantic-evidence.js";
export * from "./s2-semantic-probes.js";
export * from "./s2-complete-answer-evidence.js";
export * from "./s2-writer-citation-reconciliation.js";
export * from "./s2-question-answer-claim.js";
export * from "./s2-semantic-pipeline-trace.js";
export * from "./s2-end-to-end-evidence-trace.js";
export * from "./s2-quote-evidence-choice.js";
export * from "./s2-frozen-reader-source-bridge.js";
export * from "./s2-atomic-original-window-choice.js";
export * from "./s2-http-admitted-frozen-reader.js";
export * from "./s2-claim-corroboration.js";
export * from "./s2-pre-admission-source-discovery.js";
export * from "./s2-discovery-review-plan.js";
export * from "./s2-claim-answer-anchor.js";
export * from "./s2-actor-binding.js";
export * from "./s2-evidence-portfolio.js";
export * from "./s2-paired-semantic-probe.js";
export * from "./s2-claim-numeric-integrity.js";
export * from "./s2-evidence-window-selection.js";
export * from "./s2-windowed-claim-diagnostics.js";
export * from "./s2-pipeline-stage-ledger.js";
export * from "./s2-http-evidence-replay.js";
export * from "./s2-atomic-native-writer.js";
export * from "./s2-bm25-same-pool-shadow.js";

export interface RetrievalMetrics {
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  hit: boolean;
}

export {
  parseS2ExternalIntakeCsv,
  preflightS2IndependentIntake,
} from "./s2-independent-intake.js";
export { scoreS2PairedSemanticArms } from "./s2-prospective-paired-score.js";
export type {
  S2PairedAdjudicatedCase,
  S2EvaluatedArm,
} from "./s2-prospective-paired-score.js";
export { s2ClusterStratifiedPairedBootstrap } from "./s2-family-stratified-bootstrap.js";
export { auditS2ProspectiveSourceReview } from "./s2-prospective-source-review-audit.js";
export {
  summarizeS2DevelopmentHttpJourney,
  summarizeS2DevelopmentContextWriter,
} from "./s2-development-http-journey-metrics.js";
export type {
  S2HttpJourneySample,
  S2ContextWriterSample,
} from "./s2-development-http-journey-metrics.js";
export { summarizeS2DevelopmentFullHttp } from "./s2-development-http-writer-metrics.js";
export type { S2HttpWriterSample } from "./s2-development-http-writer-metrics.js";
export { prepareS2PreInferenceBlindReview } from "./s2-preinference-blind-review.js";
export { buildS2PrivateUnseenReviewKit } from "./s2-private-unseen-review.js";
export type { S2PrivateSourceReviewPacket } from "./s2-private-unseen-review.js";

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
