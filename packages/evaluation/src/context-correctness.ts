import { readFile } from "node:fs/promises";
import path from "node:path";

export type ContextCorrectnessRegressionKind =
  | "TEMPORAL_TRUTH_CONTRADICTION"
  | "TOKENIZATION_AND_EXACT_IDENTIFIER";

export interface ContextCorrectnessRegressionPack {
  schemaVersion: 1;
  evidenceLevel: "P0_REGRESSION_SPEC";
  productionDefaultsChanged: false;
  cases: ContextCorrectnessRegressionCase[];
}

export type ContextCorrectnessRegressionCase =
  | TemporalTruthContradictionCase
  | TokenizationIdentifierCase;

export interface TemporalTruthContradictionCase {
  id: string;
  kind: "TEMPORAL_TRUTH_CONTRADICTION";
  query: string;
  documents: Array<{
    id: string;
    validFrom: string;
    validTo: string | null;
    authority: "OFFICIAL_SUPERSEDED" | "OFFICIAL_CURRENT";
    text: string;
  }>;
  denseScores: Record<string, number>;
  expectations: {
    current: string[];
    asOfBeforeChange: string[];
    mustNotResolveBy: "DENSE_SCORE_ONLY";
    mustExposeContradiction: true;
    readTimeSupportValidationRequired: true;
  };
}

export interface TokenizationIdentifierCase {
  id: string;
  kind: "TOKENIZATION_AND_EXACT_IDENTIFIER";
  samples: {
    english: string;
    spanish: string;
    code: string;
  };
  identifiers: string[];
  expectations: {
    exactModelTokenizerPreferred: true;
    approximateFallbackMustBeLabeled: true;
    serializedContextPacketMeasured: true;
    exactOrLexicalIdentifierChannelRequired: true;
    benchmarkLanguages: Array<"en" | "es" | "code">;
  };
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string.`);
}

export function validateContextCorrectnessRegressionPack(
  candidate: unknown,
): ContextCorrectnessRegressionPack {
  if (!candidate || typeof candidate !== "object")
    throw new Error("Context correctness regression pack must be an object.");

  const value = candidate as Record<string, unknown>;
  if (value.schemaVersion !== 1)
    throw new Error("Unsupported context correctness regression schemaVersion.");
  if (value.evidenceLevel !== "P0_REGRESSION_SPEC")
    throw new Error("Context correctness regression evidenceLevel must remain P0_REGRESSION_SPEC.");
  if (value.productionDefaultsChanged !== false)
    throw new Error("P0 context correctness fixtures must not change production defaults.");
  if (!Array.isArray(value.cases) || value.cases.length === 0)
    throw new Error("Context correctness regression pack must contain cases.");

  const ids = new Set<string>();
  let temporalCases = 0;
  let tokenCases = 0;

  for (const [index, rawCase] of value.cases.entries()) {
    if (!rawCase || typeof rawCase !== "object")
      throw new Error(`Regression case ${index} must be an object.`);
    const testCase = rawCase as Record<string, unknown>;
    assertString(testCase.id, `Regression case ${index} id`);
    if (ids.has(testCase.id))
      throw new Error(`Duplicate context correctness regression id: ${testCase.id}`);
    ids.add(testCase.id);

    if (testCase.kind === "TEMPORAL_TRUTH_CONTRADICTION") {
      temporalCases += 1;
      if (!Array.isArray(testCase.documents) || testCase.documents.length < 2)
        throw new Error(`${testCase.id} must contain at least two temporal documents.`);
      if (!testCase.denseScores || typeof testCase.denseScores !== "object")
        throw new Error(`${testCase.id} must contain denseScores.`);
      const expectations = testCase.expectations as Record<string, unknown> | undefined;
      if (
        expectations?.mustNotResolveBy !== "DENSE_SCORE_ONLY" ||
        expectations.mustExposeContradiction !== true ||
        expectations.readTimeSupportValidationRequired !== true
      ) {
        throw new Error(`${testCase.id} must encode truth-before-rank expectations.`);
      }
      continue;
    }

    if (testCase.kind === "TOKENIZATION_AND_EXACT_IDENTIFIER") {
      tokenCases += 1;
      if (!Array.isArray(testCase.identifiers) || testCase.identifiers.length === 0)
        throw new Error(`${testCase.id} must contain exact identifiers.`);
      const expectations = testCase.expectations as Record<string, unknown> | undefined;
      if (
        expectations?.exactModelTokenizerPreferred !== true ||
        expectations.approximateFallbackMustBeLabeled !== true ||
        expectations.serializedContextPacketMeasured !== true ||
        expectations.exactOrLexicalIdentifierChannelRequired !== true
      ) {
        throw new Error(`${testCase.id} must encode tokenizer and exact-identifier expectations.`);
      }
      continue;
    }

    throw new Error(`Unsupported context correctness regression kind in ${testCase.id}.`);
  }

  if (temporalCases === 0 || tokenCases === 0)
    throw new Error("Context correctness regressions require both temporal-truth and tokenization cases.");

  return candidate as ContextCorrectnessRegressionPack;
}

export async function loadContextCorrectnessRegressionPack(
  repositoryRoot: string,
): Promise<ContextCorrectnessRegressionPack> {
  const file = path.join(
    repositoryRoot,
    "evals",
    "registered",
    "context-correctness-regressions.json",
  );
  return validateContextCorrectnessRegressionPack(
    JSON.parse(await readFile(file, "utf8")) as unknown,
  );
}
