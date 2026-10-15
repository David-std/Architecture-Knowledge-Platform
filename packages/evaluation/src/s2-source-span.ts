/**
 * S2 measurement boundary. This is a scorer of externally recorded results,
 * not an alternative retrieval implementation or a production admission rule.
 * It never uses a question string to alter rankings or classify evidence.
 */
export interface S2SpanGold {
  unitId: string;
  quote: string;
}

export interface S2SourceUnit {
  id: string;
  text: string;
}

export interface S2SourceDocument {
  id: string;
  domain: string;
  units: readonly S2SourceUnit[];
}

export interface S2SpanCase {
  id: string;
  sourceId: string;
  language: "en" | "es";
  answerable: boolean;
  gold: readonly S2SpanGold[];
}

export interface S2SpanFixture {
  sourceDocuments: readonly S2SourceDocument[];
  cases: readonly S2SpanCase[];
}

/** A source-byte quote must use exact UTF-16 offsets in one original unit. */
export interface S2ObservedCitation {
  unitId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}

export type S2FailureKind =
  | "INDEX_MISS"
  | "FUSED_RANK_DISPLACEMENT"
  | "WRONG_UNIT"
  | "SOURCE_SPAN_MISMATCH"
  | "READER_RELATED_NOT_ANSWERING"
  | "UNSUPPORTED_QUOTE"
  | "ACL_OR_REVISION"
  | "OTHER";

export interface S2SpanObservation {
  caseId: string;
  rankedUnitIds: readonly string[];
  admitted: readonly S2ObservedCitation[];
  /** False means candidate ranking was measured but admission was NOT run. */
  admissionMeasured?: boolean;
  elapsedMs: number;
  degraded: boolean;
  /** Only independently adjudicated answer outcomes should populate this. */
  finalAnswerCorrect?: boolean;
  /** Only counts from a pinned real model tokenizer, never char/4. */
  exactInputTokens?: number;
  tokenizerRevision?: string;
  failureKind?: S2FailureKind;
}

export interface S2SpanScore {
  evidenceLevel: "RECORDED_MEASUREMENTS_NOT_INDEPENDENTLY_ADJUDICATED";
  status: "NO_OBSERVATIONS" | "PARTIAL_NOT_GATEABLE" | "MEASURED_NOT_GATEABLE";
  totalCases: number;
  observedCases: number;
  positiveObserved: number;
  negativeObserved: number;
  missingCaseIds: string[];
  recallAt1: number | null;
  recallAt5: number | null;
  recallAt10: number | null;
  /** Strict, exact gold-quote coverage: NOT human semantic precision. */
  exactGoldQuoteCoverage: number | null;
  admittedQuoteCount: number;
  exactGoldQuoteCount: number;
  admissionObservedCases: number;
  falseAdmissionRate: number | null;
  simpleWilsonLowerForExactGoldCoverage: number | null;
  p95Ms: number | null;
  degradedRate: number | null;
  finalAnswerCorrectRate: number | null;
  tokenizerRevision: string | null;
  meanExactInputTokens: number | null;
  failureKinds: Partial<Record<S2FailureKind, number>>;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

/** Simple binomial diagnostic; this is NOT a stratified confidence interval. */
export function s2WilsonLower(
  successes: number,
  trials: number,
): number | null {
  if (trials === 0) return null;
  const z = 1.96;
  const p = successes / trials;
  const z2 = z * z;
  return (
    (p +
      z2 / (2 * trials) -
      z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    (1 + z2 / trials)
  );
}

export function scoreS2SpanObservations(
  fixture: S2SpanFixture,
  observations: readonly S2SpanObservation[],
): S2SpanScore {
  const cases = new Map(fixture.cases.map((item) => [item.id, item]));
  const sources = new Map(
    fixture.sourceDocuments.map((item) => [item.id, item]),
  );
  const units = new Map(
    fixture.sourceDocuments.flatMap((source) =>
      source.units.map(
        (unit) => [unit.id, { ...unit, sourceId: source.id }] as const,
      ),
    ),
  );
  if (
    cases.size !== fixture.cases.length ||
    sources.size !== fixture.sourceDocuments.length ||
    units.size !==
      fixture.sourceDocuments.reduce((n, doc) => n + doc.units.length, 0)
  ) {
    throw new Error("S2_FIXTURE_IDENTITIES_NOT_UNIQUE");
  }
  for (const item of fixture.cases) {
    if (!sources.has(item.sourceId)) {
      throw new Error("S2_FIXTURE_SOURCE_NOT_FOUND");
    }
    for (const gold of item.gold) {
      const sourceUnit = units.get(gold.unitId);
      if (
        !sourceUnit ||
        sourceUnit.sourceId !== item.sourceId ||
        !sourceUnit.text.includes(gold.quote)
      ) {
        throw new Error("S2_FIXTURE_GOLD_SPAN_NOT_SOURCE_BOUND");
      }
    }
  }
  const observationsById = new Map<string, S2SpanObservation>();
  const failureKinds: Partial<Record<S2FailureKind, number>> = {};
  for (const item of observations) {
    if (observationsById.has(item.caseId) || !cases.has(item.caseId)) {
      throw new Error("S2_OBSERVATION_UNKNOWN_OR_DUPLICATE_CASE");
    }
    if (
      !Number.isFinite(item.elapsedMs) ||
      item.elapsedMs < 0 ||
      typeof item.degraded !== "boolean" ||
      !Array.isArray(item.rankedUnitIds) ||
      !Array.isArray(item.admitted) ||
      (item.admissionMeasured !== undefined &&
        typeof item.admissionMeasured !== "boolean") ||
      (item.admissionMeasured === false && item.admitted.length > 0)
    ) {
      throw new Error("S2_OBSERVATION_MALFORMED");
    }
    if (
      item.exactInputTokens !== undefined &&
      (!Number.isSafeInteger(item.exactInputTokens) ||
        item.exactInputTokens < 0 ||
        !item.tokenizerRevision)
    ) {
      throw new Error("S2_OBSERVATION_TOKENIZER_NOT_PINNED");
    }
    // This frozen study authorizes one source vault per question. A
    // foreign/unknown ranked unit or duplicate rank is an invalid recorded
    // execution, not a legitimate Recall@k miss to average into the score.
    const scopedCase = cases.get(item.caseId)!;
    const seenRanks = new Set<string>();
    for (const unitId of item.rankedUnitIds) {
      const sourceUnit = units.get(unitId);
      if (
        !sourceUnit ||
        sourceUnit.sourceId !== scopedCase.sourceId ||
        seenRanks.has(unitId)
      ) {
        throw new Error("S2_OBSERVATION_UNSCOPED_OR_DUPLICATE_RANK");
      }
      seenRanks.add(unitId);
    }
    observationsById.set(item.caseId, item);
    if (item.failureKind) {
      failureKinds[item.failureKind] =
        (failureKinds[item.failureKind] ?? 0) + 1;
    }
  }

  let positiveObserved = 0;
  let negativeObserved = 0;
  let recalled1 = 0;
  let recalled5 = 0;
  let recalled10 = 0;
  let admittedQuoteCount = 0;
  let exactGoldQuoteCount = 0;
  let negativesWithAdmission = 0;
  let negativeAdmissionObserved = 0;
  let admissionObservedCases = 0;
  let degraded = 0;
  const durations: number[] = [];
  const answers: boolean[] = [];
  const missingCaseIds: string[] = [];
  const tokenCounts: number[] = [];
  const tokenizerRevisions = new Set<string>();
  for (const item of fixture.cases) {
    const observation = observationsById.get(item.id);
    if (!observation) {
      missingCaseIds.push(item.id);
      continue;
    }
    durations.push(observation.elapsedMs);
    if (observation.admissionMeasured !== false) admissionObservedCases += 1;
    if (observation.degraded) degraded += 1;
    if (typeof observation.finalAnswerCorrect === "boolean") {
      answers.push(observation.finalAnswerCorrect);
    }
    if (observation.exactInputTokens !== undefined) {
      tokenCounts.push(observation.exactInputTokens);
      tokenizerRevisions.add(observation.tokenizerRevision!);
    }

    if (item.answerable) {
      positiveObserved += 1;
      const goldUnitIds = new Set(item.gold.map((gold) => gold.unitId));
      const firstRank = observation.rankedUnitIds.findIndex((unitId) =>
        goldUnitIds.has(unitId),
      );
      if (firstRank >= 0 && firstRank < 1) recalled1 += 1;
      if (firstRank >= 0 && firstRank < 5) recalled5 += 1;
      if (firstRank >= 0 && firstRank < 10) recalled10 += 1;
    } else {
      negativeObserved += 1;
      if (observation.admissionMeasured !== false) {
        negativeAdmissionObserved += 1;
        if (observation.admitted.length > 0) negativesWithAdmission += 1;
      }
    }

    for (const citation of observation.admitted) {
      admittedQuoteCount += 1;
      const unit = units.get(citation.unitId);
      const exactSource =
        unit &&
        unit.sourceId === item.sourceId &&
        Number.isSafeInteger(citation.startOffset) &&
        Number.isSafeInteger(citation.endOffset) &&
        citation.startOffset >= 0 &&
        citation.endOffset > citation.startOffset &&
        unit.text.slice(citation.startOffset, citation.endOffset) ===
          citation.quote;
      if (
        exactSource &&
        item.gold.some(
          (gold) =>
            gold.unitId === citation.unitId &&
            citation.quote.includes(gold.quote),
        )
      ) {
        exactGoldQuoteCount += 1;
      }
    }
  }
  const fullyObserved = missingCaseIds.length === 0;
  const allAnswerOutcomes = answers.length === observations.length;
  const exactTokenReport =
    fullyObserved &&
    tokenCounts.length === observations.length &&
    tokenizerRevisions.size === 1;
  return {
    evidenceLevel: "RECORDED_MEASUREMENTS_NOT_INDEPENDENTLY_ADJUDICATED",
    status:
      observations.length === 0
        ? "NO_OBSERVATIONS"
        : fullyObserved
          ? "MEASURED_NOT_GATEABLE"
          : "PARTIAL_NOT_GATEABLE",
    totalCases: fixture.cases.length,
    observedCases: observations.length,
    positiveObserved,
    negativeObserved,
    missingCaseIds,
    recallAt1: ratio(recalled1, positiveObserved),
    recallAt5: ratio(recalled5, positiveObserved),
    recallAt10: ratio(recalled10, positiveObserved),
    exactGoldQuoteCoverage: ratio(exactGoldQuoteCount, admittedQuoteCount),
    admittedQuoteCount,
    exactGoldQuoteCount,
    admissionObservedCases,
    falseAdmissionRate:
      negativeAdmissionObserved === negativeObserved
        ? ratio(negativesWithAdmission, negativeObserved)
        : null,
    simpleWilsonLowerForExactGoldCoverage: s2WilsonLower(
      exactGoldQuoteCount,
      admittedQuoteCount,
    ),
    p95Ms: p95(durations),
    degradedRate: ratio(degraded, observations.length),
    finalAnswerCorrectRate: allAnswerOutcomes
      ? ratio(answers.filter(Boolean).length, answers.length)
      : null,
    tokenizerRevision: exactTokenReport ? [...tokenizerRevisions][0]! : null,
    meanExactInputTokens: exactTokenReport
      ? tokenCounts.reduce((sum, value) => sum + value, 0) / tokenCounts.length
      : null,
    failureKinds,
  };
}
