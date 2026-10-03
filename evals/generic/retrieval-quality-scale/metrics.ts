/** Pure scoring helpers for the R8 fixed-gold benchmark. */

export interface RankedGoldObservation {
  caseId: string;
  rankedUnitKeys: readonly string[];
  goldUnitKeys: readonly string[];
  expectNoAnswer?: boolean;
  admittedUnitKeys?: readonly string[];
}

export interface GoldRankingMetrics {
  cases: number;
  labelledCases: number;
  recallAtK: Record<string, number>;
  mrr: number;
  ndcg: number;
}

export interface FalseAcceptanceMetrics {
  cases: number;
  answerableCases: number;
  negativeCases: number;
  falseAcceptances: number;
  negativeFalseAcceptances: number;
  rate: number | null;
  negativeRate: number | null;
}

export interface ExperimentContract {
  hypothesis: string;
  failureStage: string;
  baselineSha: string;
  candidateSha: string;
  datasetVersion: string;
  datasetHash: string;
  indexGeneration: string;
  embeddingModelRevision: string;
  rerankerRevision: string;
  readerRevision: string;
  configurationHash: string;
  singleIndependentVariable: string;
  primaryMetric: string;
  guardrailMetrics: readonly string[];
  expectedFailureIfWrong: string;
  promotionRule: string;
  rollback: string;
}

export interface ExperimentContractValidation {
  complete: boolean;
  missingFields: string[];
}

export type QualityScaleOutcome = "PROMOTE" | "REJECT" | "INCONCLUSIVE";

export interface QualityScaleOutcomeSnapshot {
  recallAt10: number;
  mrr: number;
  ndcg: number;
  falseAcceptanceRate: number | null;
}

export interface QualityScaleOutcomeInput {
  baseline: QualityScaleOutcomeSnapshot | null;
  final: QualityScaleOutcomeSnapshot | null;
  contractComplete: boolean;
  smoke: boolean;
}

/**
 * Apply the R8 promotion rule to the fixed-gold baseline and 100K snapshots.
 *
 * The absolute false-acceptance ceiling is intentional: a final rate above
 * 0.20 rejects even when the increase from baseline is less than 0.05. This
 * keeps the executable gate aligned with the experiment contract.
 */
export function classifyQualityScaleOutcome(
  input: QualityScaleOutcomeInput,
): QualityScaleOutcome {
  if (input.smoke || !input.contractComplete) return "INCONCLUSIVE";
  if (!input.baseline || !input.final) return "INCONCLUSIVE";

  const { baseline, final } = input;
  const baselineFalseAcceptanceRate = baseline.falseAcceptanceRate;
  const finalFalseAcceptanceRate = final.falseAcceptanceRate;
  if (
    baselineFalseAcceptanceRate === null ||
    finalFalseAcceptanceRate === null
  ) {
    return "INCONCLUSIVE";
  }
  if (
    baselineFalseAcceptanceRate > 0.2 ||
    finalFalseAcceptanceRate > 0.2 ||
    final.recallAt10 < baseline.recallAt10 - 0.05 ||
    final.mrr < baseline.mrr - 0.05 ||
    final.ndcg < baseline.ndcg - 0.05 ||
    finalFalseAcceptanceRate > baselineFalseAcceptanceRate + 0.05
  ) {
    return "REJECT";
  }
  return "PROMOTE";
}

const CONTRACT_FIELDS: readonly (keyof ExperimentContract)[] = [
  "hypothesis",
  "failureStage",
  "baselineSha",
  "candidateSha",
  "datasetVersion",
  "datasetHash",
  "indexGeneration",
  "embeddingModelRevision",
  "rerankerRevision",
  "readerRevision",
  "configurationHash",
  "singleIndependentVariable",
  "primaryMetric",
  "guardrailMetrics",
  "expectedFailureIfWrong",
  "promotionRule",
  "rollback",
];

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function hitRank(
  rankedUnitKeys: readonly string[],
  goldUnitKeys: readonly string[],
): number | null {
  const gold = new Set(goldUnitKeys);
  const index = rankedUnitKeys.findIndex((key) => gold.has(key));
  return index < 0 ? null : index + 1;
}

function dcg(ranks: readonly number[]): number {
  return ranks.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
}

/** Compute binary relevance metrics over independently labelled unit keys. */
export function scoreGoldRanking(
  observations: readonly RankedGoldObservation[],
  kValues: readonly number[] = [1, 5, 10, 20],
): GoldRankingMetrics {
  const validK = [...new Set(kValues)]
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => left - right);
  const labelled = observations.filter((observation) => {
    return (
      observation.expectNoAnswer !== true && observation.goldUnitKeys.length > 0
    );
  });
  const recallAtK = Object.fromEntries(
    validK.map((k) => [
      String(k),
      labelled.length === 0
        ? 0
        : labelled.reduce((sum, observation) => {
            const gold = new Set(observation.goldUnitKeys);
            return (
              sum +
              Number(
                observation.rankedUnitKeys
                  .slice(0, k)
                  .some((key) => gold.has(key)),
              )
            );
          }, 0) / labelled.length,
    ]),
  );
  const reciprocalRanks = labelled.map((observation) => {
    const rank = hitRank(observation.rankedUnitKeys, observation.goldUnitKeys);
    return rank === null ? 0 : 1 / rank;
  });
  const ndcgValues = labelled.map((observation) => {
    const gold = new Set(observation.goldUnitKeys);
    const relevantRanks = observation.rankedUnitKeys.flatMap((key, index) =>
      gold.has(key) ? [index + 1] : [],
    );
    if (relevantRanks.length === 0) return 0;
    const idealRanks = observation.goldUnitKeys.map((_, index) => index + 1);
    return dcg(relevantRanks) / dcg(idealRanks);
  });
  return {
    cases: observations.length,
    labelledCases: labelled.length,
    recallAtK,
    mrr:
      reciprocalRanks.length === 0
        ? 0
        : reciprocalRanks.reduce((sum, value) => sum + value, 0) /
          reciprocalRanks.length,
    ndcg:
      ndcgValues.length === 0
        ? 0
        : ndcgValues.reduce((sum, value) => sum + value, 0) / ndcgValues.length,
  };
}

/**
 * Score support/admission separately from ranking relevance.
 *
 * A positive case is a false acceptance when an admitted unit is outside its
 * fixed gold set. A no-answer case is a false acceptance when any unit is
 * admitted. This keeps rank quality and evidence acceptance denominators
 * explicit instead of collapsing them into one percentage.
 */
export function scoreFalseAcceptance(
  observations: readonly RankedGoldObservation[],
): FalseAcceptanceMetrics {
  const negativeCases = observations.filter(
    (observation) => observation.expectNoAnswer === true,
  );
  const answerableCases = observations.filter(
    (observation) => observation.expectNoAnswer !== true,
  );
  let falseAcceptances = 0;
  let negativeFalseAcceptances = 0;
  for (const observation of observations) {
    const admitted = observation.admittedUnitKeys ?? [];
    const gold = new Set(observation.goldUnitKeys);
    const falseAcceptance =
      observation.expectNoAnswer === true
        ? admitted.length > 0
        : admitted.some((key) => !gold.has(key));
    if (falseAcceptance) falseAcceptances += 1;
    if (observation.expectNoAnswer === true && falseAcceptance) {
      negativeFalseAcceptances += 1;
    }
  }
  return {
    cases: observations.length,
    answerableCases: answerableCases.length,
    negativeCases: negativeCases.length,
    falseAcceptances,
    negativeFalseAcceptances,
    rate:
      observations.length === 0 ? null : falseAcceptances / observations.length,
    negativeRate:
      negativeCases.length === 0
        ? null
        : negativeFalseAcceptances / negativeCases.length,
  };
}

export function validateExperimentContract(
  contract: Partial<ExperimentContract>,
): ExperimentContractValidation {
  const missingFields = CONTRACT_FIELDS.filter((field) => {
    const value = contract[field];
    if (Array.isArray(value)) return value.length === 0;
    return typeof value !== "string" || value.trim().length === 0;
  });
  return { complete: missingFields.length === 0, missingFields };
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return finiteOrZero(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

export function percentile(
  values: readonly number[],
  quantile: number,
): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error("percentile quantile must be between 0 and 1");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return finiteOrZero(
    lowerValue + (upperValue - lowerValue) * (position - lower),
  );
}
