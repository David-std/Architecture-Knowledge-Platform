import { createHash } from "node:crypto";

/**
 * A descriptive score for a complete, externally pinned experiment.
 * Schema validation does not authenticate annotators or replay private HTTP
 * receipts. Never use this report alone to approve a release.
 */
const sha = (input: Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const hex = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const fail = (reason: string): never => {
  throw Error("S2_STAGE_LEDGER_" + reason);
};
const obj = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export const S2_PIPELINE_STAGES = [
  "AUTHORIZATION",
  "RETRIEVAL",
  "REVISION_RECHECK",
  "EVIDENCE_SELECTION",
  "SEMANTIC_VERIFICATION",
  "SOURCE_ATTRIBUTION",
  "ANSWER_COMPOSITION",
] as const;
export type S2PipelineStage = (typeof S2_PIPELINE_STAGES)[number];
export type S2StageResult = "PASSED" | "WITHHELD" | "ERROR" | "NOT_RUN";
export type S2CaseGold =
  | "EXPLICIT_SUPPORT"
  | "EXPLICIT_REFUTATION"
  | "NOT_ANSWERABLE"
  | "AMBIGUOUS"
  | "CONFLICTING_EVIDENCE";
export interface S2FrozenPipelineCase {
  readonly questionKeySha256: string;
  readonly sourceFamilySha256: string;
  readonly language: "en" | "es";
  readonly gold: S2CaseGold;
}
export interface S2FrozenPipelineManifest {
  readonly schemaVersion: "akp.s2.pipeline-stage-manifest.v1";
  readonly executedCommitSha: string;
  readonly sourceManifestSha256: string;
  readonly cases: readonly S2FrozenPipelineCase[];
}
export interface S2CapturedPipelineCase {
  readonly questionKeySha256: string;
  readonly stages: Readonly<Record<S2PipelineStage, S2StageResult>>;
  readonly disposition: "ANSWERED" | "WITHHELD";
  /** Raw response digest, not a claim that response bytes were independently replayed. */
  readonly responseSha256: string;
  /** Required for ANSWERED, but not sufficient to establish citation validity. */
  readonly citationReceiptSha256: string | null;
  readonly durationMs: number;
}
export interface S2PipelineStageRun {
  readonly schemaVersion: "akp.s2.pipeline-stage-run.v1";
  readonly executedCommitSha: string;
  readonly sourceManifestSha256: string;
  readonly mode: "SHADOW_ONLY";
  readonly cases: readonly S2CapturedPipelineCase[];
}
export interface S2PipelineStageLedger {
  readonly schemaVersion: "akp.s2.pipeline-stage-ledger.v1";
  readonly status: "DESCRIPTIVE_ONLY_NOT_ACCEPTANCE";
  readonly manifestSha256: string;
  readonly executedCommitSha: string;
  readonly caseCount: number;
  readonly distinctFamilyCount: number;
  readonly languageCounts: Readonly<Record<"en" | "es", number>>;
  readonly labels: Readonly<Record<S2CaseGold, number>>;
  /** Contradicted means an explicit 'no' can still be a valid answer. */
  readonly explicitAnswerable: number;
  readonly explicitlyAnswered: number;
  readonly negativeCaseCount: number;
  readonly negativeFalseAdmissions: number;
  readonly observedNegativeFalseAdmissionRate: number;
  /** One-sided Wilson 95% bound, not an acceptance threshold. */
  readonly negativeFalseAdmissionUpper95: number;
  readonly stages: Readonly<
    Record<S2PipelineStage, Readonly<Record<S2StageResult, number>>>
  >;
  readonly p95RequestMs: number;
  readonly allRequestedCasesAccountedFor: true;
  readonly independentGoldAuthenticated: false;
  readonly rawResponseBytesReplayed: false;
  readonly citationProvenanceIndependentlyVerified: false;
  readonly completeAnswerCorrectness: null;
  readonly gateAccepted: false;
}

const stages = new Set<string>(S2_PIPELINE_STAGES);
const stageStatuses = new Set<S2StageResult>([
  "PASSED",
  "WITHHELD",
  "ERROR",
  "NOT_RUN",
]);
const labels = new Set<S2CaseGold>([
  "EXPLICIT_SUPPORT",
  "EXPLICIT_REFUTATION",
  "NOT_ANSWERABLE",
  "AMBIGUOUS",
  "CONFLICTING_EVIDENCE",
]);
function wilsonUpper95(errors: number, total: number): number {
  if (total === 0) return 1;
  const z = 1.6448536269514722;
  const z2 = z * z;
  const p = errors / total;
  return Math.min(
    1,
    (p +
      z2 / (2 * total) +
      z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) /
      (1 + z2 / total),
  );
}
function validManifestCase(value: unknown): value is S2FrozenPipelineCase {
  return (
    obj(value) &&
    hasKeys(value, [
      "questionKeySha256",
      "sourceFamilySha256",
      "language",
      "gold",
    ]) &&
    hex.test(String(value.questionKeySha256)) &&
    hex.test(String(value.sourceFamilySha256)) &&
    (value.language === "en" || value.language === "es") &&
    labels.has(value.gold as S2CaseGold)
  );
}
function validStageMap(value: unknown): boolean {
  return (
    obj(value) &&
    Object.keys(value).length === S2_PIPELINE_STAGES.length &&
    Object.keys(value).every(
      (key) =>
        stages.has(key) && stageStatuses.has(value[key] as S2StageResult),
    )
  );
}
function validRunCase(value: unknown): value is S2CapturedPipelineCase {
  return (
    obj(value) &&
    hasKeys(value, [
      "questionKeySha256",
      "stages",
      "disposition",
      "responseSha256",
      "citationReceiptSha256",
      "durationMs",
    ]) &&
    hex.test(String(value.questionKeySha256)) &&
    hex.test(String(value.responseSha256)) &&
    validStageMap(value.stages) &&
    (value.disposition === "ANSWERED" || value.disposition === "WITHHELD") &&
    (value.citationReceiptSha256 === null ||
      hex.test(String(value.citationReceiptSha256))) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}
export function scoreS2PipelineStageLedger(input: {
  manifestBytes: Uint8Array;
  externallyPinnedManifestSha256: string;
  run: S2PipelineStageRun;
}): S2PipelineStageLedger {
  if (
    !hex.test(input.externallyPinnedManifestSha256) ||
    input.manifestBytes.byteLength < 16 ||
    input.manifestBytes.byteLength > 3_000_000 ||
    sha(input.manifestBytes) !== input.externallyPinnedManifestSha256
  )
    fail("MANIFEST_PIN_MISMATCH");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.manifestBytes),
    ) as unknown;
  } catch {
    fail("MANIFEST_INVALID");
  }
  if (
    !obj(parsed) ||
    !hasKeys(parsed, [
      "schemaVersion",
      "executedCommitSha",
      "sourceManifestSha256",
      "cases",
    ]) ||
    parsed.schemaVersion !== "akp.s2.pipeline-stage-manifest.v1" ||
    !commit.test(String(parsed.executedCommitSha)) ||
    !hex.test(String(parsed.sourceManifestSha256)) ||
    !Array.isArray(parsed.cases) ||
    parsed.cases.length < 2 ||
    parsed.cases.length > 10_000 ||
    !parsed.cases.every(validManifestCase)
  )
    fail("MANIFEST_INVALID");
  const manifest = parsed as unknown as S2FrozenPipelineManifest;
  const expected = new Map(manifest.cases.map((c) => [c.questionKeySha256, c]));
  if (
    expected.size !== manifest.cases.length ||
    new Set(manifest.cases.map((c) => c.sourceFamilySha256)).size < 2 ||
    !manifest.cases.some(
      (c) =>
        c.gold === "NOT_ANSWERABLE" ||
        c.gold === "AMBIGUOUS" ||
        c.gold === "CONFLICTING_EVIDENCE",
    )
  )
    fail("MANIFEST_CASES_NOT_DISJOINT_OR_NO_NEGATIVES");
  const run = input.run;
  if (
    run?.schemaVersion !== "akp.s2.pipeline-stage-run.v1" ||
    run.mode !== "SHADOW_ONLY" ||
    run.executedCommitSha !== manifest.executedCommitSha ||
    run.sourceManifestSha256 !== manifest.sourceManifestSha256 ||
    !Array.isArray(run.cases) ||
    run.cases.length !== manifest.cases.length ||
    !run.cases.every(validRunCase)
  )
    fail("RUN_IDENTITY_OR_SHAPE_INVALID");
  const seen = new Set<string>();
  const labelCount = Object.fromEntries(
    [...labels].map((key) => [key, 0]),
  ) as Record<S2CaseGold, number>;
  const stageCount = Object.fromEntries(
    S2_PIPELINE_STAGES.map((stage) => [
      stage,
      { PASSED: 0, WITHHELD: 0, ERROR: 0, NOT_RUN: 0 },
    ]),
  ) as Record<S2PipelineStage, Record<S2StageResult, number>>;
  const languageCounts = { en: 0, es: 0 };
  const durations: number[] = [];
  let explicitAnswerable = 0;
  let explicitlyAnswered = 0;
  let negativeCaseCount = 0;
  let negativeFalseAdmissions = 0;
  for (const row of run.cases) {
    const original = expected.get(row.questionKeySha256);
    if (original === undefined) {
      throw new Error("S2_STAGE_LEDGER_MISSING_DUPLICATE_OR_UNEXPECTED_CASE");
    }
    if (seen.has(row.questionKeySha256))
      fail("MISSING_DUPLICATE_OR_UNEXPECTED_CASE");
    seen.add(row.questionKeySha256);
    if (
      row.disposition === "ANSWERED" &&
      (row.citationReceiptSha256 === null ||
        S2_PIPELINE_STAGES.some((stage) => row.stages[stage] !== "PASSED"))
    )
      fail("ANSWER_WITH_MISSING_STAGE_OR_CITATION");
    if (row.disposition === "WITHHELD" && row.citationReceiptSha256 !== null)
      fail("WITHHELD_WITH_CITATION_RECEIPT");
    labelCount[original.gold]++;
    languageCounts[original.language]++;
    durations.push(row.durationMs);
    for (const stage of S2_PIPELINE_STAGES)
      stageCount[stage][row.stages[stage]]++;
    if (
      original.gold === "EXPLICIT_SUPPORT" ||
      original.gold === "EXPLICIT_REFUTATION"
    ) {
      explicitAnswerable++;
      if (row.disposition === "ANSWERED") explicitlyAnswered++;
    } else {
      negativeCaseCount++;
      if (row.disposition === "ANSWERED") negativeFalseAdmissions++;
    }
  }
  durations.sort((a, b) => a - b);
  return {
    schemaVersion: "akp.s2.pipeline-stage-ledger.v1",
    status: "DESCRIPTIVE_ONLY_NOT_ACCEPTANCE",
    manifestSha256: input.externallyPinnedManifestSha256,
    executedCommitSha: manifest.executedCommitSha,
    caseCount: manifest.cases.length,
    distinctFamilyCount: new Set(
      manifest.cases.map((c) => c.sourceFamilySha256),
    ).size,
    languageCounts,
    labels: labelCount,
    explicitAnswerable,
    explicitlyAnswered,
    negativeCaseCount,
    negativeFalseAdmissions,
    observedNegativeFalseAdmissionRate:
      negativeFalseAdmissions / negativeCaseCount,
    negativeFalseAdmissionUpper95: wilsonUpper95(
      negativeFalseAdmissions,
      negativeCaseCount,
    ),
    stages: stageCount,
    p95RequestMs: durations[Math.ceil(durations.length * 0.95) - 1]!,
    allRequestedCasesAccountedFor: true,
    independentGoldAuthenticated: false,
    rawResponseBytesReplayed: false,
    citationProvenanceIndependentlyVerified: false,
    completeAnswerCorrectness: null,
    gateAccepted: false,
  };
}
