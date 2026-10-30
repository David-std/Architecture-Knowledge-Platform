import { createHash } from "node:crypto";

/**
 * Offline preparation-only comparison of child retrieval against observed,
 * source-rebound parent SECTION visibility. This scorer receives no queries,
 * answers, gold labels or raw source text, and does not certify S2.
 */
const HEX = /^[a-f0-9]{64}$/u;
const SHA = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const MAX_CASES = 10_000;
const MAX_CANDIDATES = 64;

export interface FrozenSectionPairCase {
  caseKeySha256: string;
  scopeSha256: string;
  sourceFamilySha256: string;
  language: "en" | "es";
}
export interface FrozenSectionPairManifest {
  schemaVersion: "akp.s2.section-paired-manifest.v1";
  executedCommitSha: string;
  sourceManifestSha256: string;
  cases: FrozenSectionPairCase[];
}
export type SectionProvenanceStatus =
  | "FROZEN_FILE_SPAN_MATCHED"
  | "ORIGINAL_FILE_HASH_MISMATCH"
  | "REVISION_IDENTITY_MISMATCH"
  | "ORIGINAL_BODY_FRAME_INVALID"
  | "ORIGINAL_BODY_PROJECTION_MISMATCH"
  | "ORIGINAL_SPAN_OUT_OF_BOUNDS"
  | "ORIGINAL_SPAN_HASH_MISMATCH"
  | "ORIGINAL_SECTION_TEXT_MISMATCH"
  | "NOT_VERIFIED";
export interface SectionPairCapture {
  caseKeySha256: string;
  scopeSha256: string;
  /** The original query's full child-only search request, excluding shadow. */
  childRequestMs: number;
  childDegraded: boolean;
  eligibleChildKeysSha256: string[];
  /** Time spent exclusively on the SECTION shadow query and checks. */
  sectionLookupMs: number;
  shadowErrorCode: string | null;
  sectionCandidates: {
    sectionKeySha256: string;
    childKeySha256: string;
    originalStatus: SectionProvenanceStatus;
  }[];
}
export interface SectionPairRun {
  schemaVersion: "akp.s2.section-paired-run.v1";
  executedCommitSha: string;
  sourceManifestSha256: string;
  mode: "SHADOW_ONLY";
  captures: SectionPairCapture[];
}
export interface SectionPairReport {
  schemaVersion: "akp.s2.section-paired-aggregate.v1";
  status: "DESCRIPTIVE_ONLY_NOT_GATEABLE";
  manifestPinMatched: true;
  manifestSha256: string;
  executedCommitSha: string;
  caseCount: number;
  distinctFamilyCount: number;
  languages: { en: number; es: number };
  childEligibleCount: number;
  parentCandidateCount: number;
  verifiedParentCount: number;
  casesWithVerifiedParent: number;
  casesWithParentButNoVerifiedSpan: number;
  shadowErrorCases: number;
  rejectedParentStatuses: Partial<Record<SectionProvenanceStatus, number>>;
  childRequestP95Ms: number | null;
  sectionLookupP95Ms: number | null;
  /** NOT the full request p95 of a proposed parent-answer pipeline. */
  sectionFullRequestP95Ms: null;
  sectionModelInputTokens: null;
  incrementalCostUsd: null;
  semanticPrecision: null;
  falseAdmissionRate: null;
  answerCorrectness: null;
  independentHoldoutEstablished: false;
  externalCustodyIndependentlyAttested: false;
  groundTruthLoaded: false;
  actualSectionAdmissionMeasured: false;
  gateAccepted: false;
}
const fail = (code: string): never => {
  throw new Error("S2_SECTION_PAIR_" + code);
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, target: string[]): boolean =>
  Object.keys(value).length === target.length &&
  target.every((key) => Object.hasOwn(value, key));
const finiteMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const p95 = (input: number[]): number | null => {
  if (input.length === 0) return null;
  const sorted = [...input].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
};
function validCase(value: unknown): value is FrozenSectionPairCase {
  return (
    object(value) &&
    keys(value, [
      "caseKeySha256",
      "scopeSha256",
      "sourceFamilySha256",
      "language",
    ]) &&
    HEX.test(String(value.caseKeySha256)) &&
    HEX.test(String(value.scopeSha256)) &&
    HEX.test(String(value.sourceFamilySha256)) &&
    (value.language === "en" || value.language === "es")
  );
}
const statuses = new Set<SectionProvenanceStatus>([
  "FROZEN_FILE_SPAN_MATCHED",
  "ORIGINAL_FILE_HASH_MISMATCH",
  "REVISION_IDENTITY_MISMATCH",
  "ORIGINAL_BODY_FRAME_INVALID",
  "ORIGINAL_BODY_PROJECTION_MISMATCH",
  "ORIGINAL_SPAN_OUT_OF_BOUNDS",
  "ORIGINAL_SPAN_HASH_MISMATCH",
  "ORIGINAL_SECTION_TEXT_MISMATCH",
  "NOT_VERIFIED",
]);

export function scoreSectionPairedShadow(input: {
  manifestBytes: Uint8Array;
  externallyPinnedManifestSha256: string;
  run: SectionPairRun;
}): SectionPairReport {
  if (
    !HEX.test(input.externallyPinnedManifestSha256) ||
    input.manifestBytes.byteLength < 8 ||
    input.manifestBytes.byteLength > 2_000_000 ||
    SHA(input.manifestBytes) !== input.externallyPinnedManifestSha256
  )
    fail("MANIFEST_PIN_MISMATCH");
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.manifestBytes),
    );
  } catch {
    fail("MANIFEST_INVALID");
  }
  if (
    !object(decoded) ||
    !keys(decoded, [
      "schemaVersion",
      "executedCommitSha",
      "sourceManifestSha256",
      "cases",
    ]) ||
    decoded.schemaVersion !== "akp.s2.section-paired-manifest.v1" ||
    typeof decoded.executedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(decoded.executedCommitSha) ||
    typeof decoded.sourceManifestSha256 !== "string" ||
    !HEX.test(decoded.sourceManifestSha256) ||
    !Array.isArray(decoded.cases) ||
    decoded.cases.length === 0 ||
    decoded.cases.length > MAX_CASES ||
    !decoded.cases.every(validCase)
  )
    fail("MANIFEST_INVALID");

  const manifest = decoded as unknown as FrozenSectionPairManifest;
  const expected = new Map<string, FrozenSectionPairCase>();
  for (const row of manifest.cases) {
    if (expected.has(row.caseKeySha256)) fail("DUPLICATE_CASE");
    expected.set(row.caseKeySha256, row);
  }
  const run = input.run;
  if (
    !object(run) ||
    !keys(run, [
      "schemaVersion",
      "executedCommitSha",
      "sourceManifestSha256",
      "mode",
      "captures",
    ]) ||
    run.schemaVersion !== "akp.s2.section-paired-run.v1" ||
    run.mode !== "SHADOW_ONLY" ||
    run.executedCommitSha !== manifest.executedCommitSha ||
    run.sourceManifestSha256 !== manifest.sourceManifestSha256 ||
    !Array.isArray(run.captures) ||
    run.captures.length !== expected.size
  )
    fail("RUN_IDENTITY_OR_SCOPE_MISMATCH");

  let childEligibleCount = 0,
    parentCandidateCount = 0,
    verifiedParentCount = 0;
  let casesWithVerifiedParent = 0,
    casesWithParentButNoVerifiedSpan = 0;
  let shadowErrorCases = 0;
  const rejectedParentStatuses: Partial<
    Record<SectionProvenanceStatus, number>
  > = {};
  const seenCases = new Set<string>();
  const childLatencies: number[] = [],
    sectionLatencies: number[] = [];
  const languages = { en: 0, es: 0 };
  for (const capture of run.captures) {
    if (
      !object(capture) ||
      !keys(capture, [
        "caseKeySha256",
        "scopeSha256",
        "childRequestMs",
        "childDegraded",
        "eligibleChildKeysSha256",
        "sectionLookupMs",
        "shadowErrorCode",
        "sectionCandidates",
      ])
    )
      fail("CAPTURE_INVALID");
    const manifestCase = expected.get(capture.caseKeySha256);
    if (
      !manifestCase ||
      capture.scopeSha256 !== manifestCase.scopeSha256 ||
      seenCases.has(capture.caseKeySha256) ||
      !finiteMs(capture.childRequestMs) ||
      !finiteMs(capture.sectionLookupMs) ||
      typeof capture.childDegraded !== "boolean" ||
      !Array.isArray(capture.eligibleChildKeysSha256) ||
      capture.eligibleChildKeysSha256.length > MAX_CANDIDATES ||
      capture.eligibleChildKeysSha256.some(
        (k) => typeof k !== "string" || !HEX.test(k),
      ) ||
      new Set(capture.eligibleChildKeysSha256).size !==
        capture.eligibleChildKeysSha256.length ||
      !Array.isArray(capture.sectionCandidates) ||
      capture.sectionCandidates.length > MAX_CANDIDATES ||
      !(
        capture.shadowErrorCode === null ||
        (typeof capture.shadowErrorCode === "string" &&
          /^[A-Z][A-Z0-9_]{1,100}$/u.test(capture.shadowErrorCode))
      ) ||
      (capture.shadowErrorCode !== null &&
        capture.sectionCandidates.length !== 0)
    )
      fail("CAPTURE_INVALID");

    if (!manifestCase) fail("CAPTURE_INVALID");
    seenCases.add(capture.caseKeySha256);
    languages[manifestCase!.language] += 1;
    childEligibleCount += capture.eligibleChildKeysSha256.length;
    childLatencies.push(capture.childRequestMs);
    sectionLatencies.push(capture.sectionLookupMs);
    if (capture.shadowErrorCode) shadowErrorCases += 1;
    let verified = 0;
    const knownChildKeys = new Set(capture.eligibleChildKeysSha256);
    const sectionIds = new Set<string>();
    for (const section of capture.sectionCandidates) {
      if (
        !object(section) ||
        !keys(section, [
          "sectionKeySha256",
          "childKeySha256",
          "originalStatus",
        ]) ||
        typeof section.sectionKeySha256 !== "string" ||
        !HEX.test(section.sectionKeySha256) ||
        typeof section.childKeySha256 !== "string" ||
        !HEX.test(section.childKeySha256) ||
        !knownChildKeys.has(section.childKeySha256) ||
        sectionIds.has(section.sectionKeySha256) ||
        !statuses.has(section.originalStatus)
      )
        fail("SECTION_NOT_TIED_TO_AUTHORIZED_CHILD");
      sectionIds.add(section.sectionKeySha256);
      parentCandidateCount += 1;
      if (section.originalStatus === "FROZEN_FILE_SPAN_MATCHED") {
        verified += 1;
        verifiedParentCount += 1;
      } else {
        rejectedParentStatuses[section.originalStatus] =
          (rejectedParentStatuses[section.originalStatus] ?? 0) + 1;
      }
    }
    if (verified > 0) casesWithVerifiedParent += 1;
    if (sectionIds.size > 0 && verified === 0)
      casesWithParentButNoVerifiedSpan += 1;
  }
  if (seenCases.size !== expected.size) fail("MISSING_CASE");
  return {
    schemaVersion: "akp.s2.section-paired-aggregate.v1",
    status: "DESCRIPTIVE_ONLY_NOT_GATEABLE",
    manifestPinMatched: true,
    manifestSha256: input.externallyPinnedManifestSha256,
    executedCommitSha: run.executedCommitSha,
    caseCount: expected.size,
    distinctFamilyCount: new Set(
      manifest.cases.map((c) => c.sourceFamilySha256),
    ).size,
    languages,
    childEligibleCount,
    parentCandidateCount,
    verifiedParentCount,
    casesWithVerifiedParent,
    casesWithParentButNoVerifiedSpan,
    shadowErrorCases,
    rejectedParentStatuses,
    childRequestP95Ms: p95(childLatencies),
    sectionLookupP95Ms: p95(sectionLatencies),
    sectionFullRequestP95Ms: null,
    sectionModelInputTokens: null,
    incrementalCostUsd: null,
    semanticPrecision: null,
    falseAdmissionRate: null,
    answerCorrectness: null,
    independentHoldoutEstablished: false,
    externalCustodyIndependentlyAttested: false,
    groundTruthLoaded: false,
    actualSectionAdmissionMeasured: false,
    gateAccepted: false,
  };
}
