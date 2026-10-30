/**
 * Offline selective-answer evaluation. No model calls and no source/query
 * content: callers supply owner-adjudicated labels and query outcomes.
 * Unknown labels are not silently counted as correct, wrong, or abstentions.
 */

export type OwnerEvidenceVerdict =
  "ANSWERS" | "RELATED_NOT_ANSWERING" | "WRONG";

export interface OwnerEvidenceLabel {
  readonly evidenceId: string;
  readonly verdict?: OwnerEvidenceVerdict;
}

export interface SelectiveQueryOutcome {
  readonly queryId: string;
  readonly answerable: boolean;
  readonly emitted: boolean;
  /** Independent owner judgment, mandatory for graded emitted answers. */
  readonly correct?: boolean;
}

export interface GradedProportion {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly wilson95Lower: number | null;
}

/** Wilson score bound, z=1.959963984540054, for binary adjudications. */
export function gradedProportion(
  numerator: number,
  denominator: number,
): GradedProportion {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator < 0 ||
    numerator > denominator
  ) {
    throw new Error("SELECTIVE_EVALUATION_COUNT_INVALID");
  }
  if (denominator === 0) {
    return { numerator, denominator, rate: null, wilson95Lower: null };
  }
  const z = 1.959963984540054;
  const z2 = z * z;
  const rate = numerator / denominator;
  const lower =
    (rate +
      z2 / (2 * denominator) -
      z *
        Math.sqrt((rate * (1 - rate) + z2 / (4 * denominator)) / denominator)) /
    (1 + z2 / denominator);
  return {
    numerator,
    denominator,
    rate,
    wilson95Lower: Math.max(0, lower),
  };
}

function requireUnique(ids: readonly string[], kind: string): void {
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error(`SELECTIVE_EVALUATION_${kind}_IDS_INVALID`);
  }
}

export interface EvidencePrecisionReport {
  readonly total: number;
  readonly labeled: number;
  readonly pending: number;
  /** Null until EVERY admitted evidence in the submitted sample is labeled. */
  readonly precision: GradedProportion | null;
  readonly classCounts: Record<OwnerEvidenceVerdict, number>;
}

export function evaluateOwnerEvidencePrecision(
  rows: readonly OwnerEvidenceLabel[],
): EvidencePrecisionReport {
  requireUnique(
    rows.map((row) => row.evidenceId),
    "EVIDENCE",
  );
  const classCounts: Record<OwnerEvidenceVerdict, number> = {
    ANSWERS: 0,
    RELATED_NOT_ANSWERING: 0,
    WRONG: 0,
  };
  let labeled = 0;
  for (const row of rows) {
    if (row.verdict === undefined) continue;
    if (!Object.hasOwn(classCounts, row.verdict)) {
      throw new Error("SELECTIVE_EVALUATION_VERDICT_INVALID");
    }
    classCounts[row.verdict]++;
    labeled++;
  }
  return {
    total: rows.length,
    labeled,
    pending: rows.length - labeled,
    precision:
      labeled === rows.length
        ? gradedProportion(classCounts.ANSWERS, labeled)
        : null,
    classCounts,
  };
}

export interface SelectiveQueryReport {
  readonly total: number;
  readonly emitted: number;
  readonly abstained: number;
  readonly coverage: GradedProportion;
  readonly negativeFalseAdmissionRate: GradedProportion;
  /**
   * Precise query-level correctness is unknown until every emitted answer
   * is independently judged, even when evidence spans match source text.
   */
  readonly emittedAnswerPrecision: GradedProportion | null;
}

export function evaluateSelectiveQueryOutcomes(
  rows: readonly SelectiveQueryOutcome[],
): SelectiveQueryReport {
  requireUnique(
    rows.map((row) => row.queryId),
    "QUERY",
  );
  if (rows.some((row) => !row.emitted && row.correct !== undefined)) {
    throw new Error("SELECTIVE_EVALUATION_ABSTENTION_CANNOT_BE_GRADED");
  }
  const emitted = rows.filter((row) => row.emitted);
  const negative = rows.filter((row) => !row.answerable);
  const allEmittedLabeled = emitted.every(
    (row) => typeof row.correct === "boolean",
  );
  return {
    total: rows.length,
    emitted: emitted.length,
    abstained: rows.length - emitted.length,
    coverage: gradedProportion(emitted.length, rows.length),
    negativeFalseAdmissionRate: gradedProportion(
      negative.filter((row) => row.emitted).length,
      negative.length,
    ),
    emittedAnswerPrecision: allEmittedLabeled
      ? gradedProportion(
          emitted.filter((row) => row.correct).length,
          emitted.length,
        )
      : null,
  };
}
