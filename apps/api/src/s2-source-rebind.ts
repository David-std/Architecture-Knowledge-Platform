/**
 * Evaluation-only rebinding of redacted S2 admission traces to authorized,
 * immutable source-unit bytes. This module neither calls nor influences the
 * reader, and it never accepts gold labels or returns source text.
 */
import { createHash } from "node:crypto";
import type { S2AdmissionShadowObservation } from "./s2-admission-shadow.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function codePointBoundary(value: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < value.length &&
    value.charCodeAt(offset - 1) >= 0xd800 &&
    value.charCodeAt(offset - 1) <= 0xdbff &&
    value.charCodeAt(offset) >= 0xdc00 &&
    value.charCodeAt(offset) <= 0xdfff
  );
}

export interface S2AuthorizedSourceCandidate {
  vaultId: string;
  documentId: string;
  unitId: string | null;
  revision: string;
  /** Exact SearchHit.excerpt used by the executing application. */
  excerpt: string;
  /** Source-unit bytes at that revision, acquired via an authorized snapshot. */
  sourceUnitText: string;
  /** Pin supplied by an independently frozen source manifest. */
  sourceUnitSha256: string;
}

export interface S2AuthorizedSourceSnapshot {
  query: string;
  authorizedVaultIds: string[];
  candidates: S2AuthorizedSourceCandidate[];
}

export type S2SourceRebindStatus =
  | "NOT_ADMITTED"
  | "ADMITTED_NO_READER_SPAN"
  | "INVALID_EXCERPT_SPAN"
  | "SOURCE_EXCERPT_MISSING"
  | "SOURCE_EXCERPT_AMBIGUOUS"
  | "SOURCE_SPAN_HASH_MISMATCH"
  | "SOURCE_SPAN_REBOUND";

export interface S2SourceReboundDecision {
  candidateKeySha256: string;
  status: S2SourceRebindStatus;
  /** Exact UTF-16 location in the supplied original source unit. */
  sourceSpan: null | {
    startOffsetUtf16: number;
    endOffsetUtf16: number;
    quoteSha256: string;
  };
}

export interface S2SourceRebindResult {
  schemaVersion: "akp.s2.source-rebind.v1";
  status: "SOURCE_BYTES_CHECKED_SEMANTIC_SUFFICIENCY_NOT_MEASURED";
  querySha256: string;
  scopeSha256: string;
  surface: "search" | "context";
  admittedCount: number;
  admittedWithSourceReboundSpan: number;
  admittedWithoutSourceReboundSpan: number;
  results: S2SourceReboundDecision[];
  /** External provenance, human correctness and S2 gate are not asserted. */
  sourceProvenanceExternallyVerified: false;
  gateAccepted: false;
}

/**
 * Fails closed on missing/extra, unauthorized, stale or unpinned candidates.
 * An excerpt must occur exactly once in the original unit: guessing between
 * identical occurrences would fabricate an original-source offset.
 */
export function rebindS2AdmissionToSource(
  observation: S2AdmissionShadowObservation,
  source: S2AuthorizedSourceSnapshot,
): S2SourceRebindResult {
  if (
    observation.schemaVersion !== "akp.s2.admission-shadow.v1" ||
    observation.status !==
      "ACTUAL_APPLICATION_ADMISSION_DECISION_NOT_GOLD_SCORED" ||
    observation.gateAccepted !== false ||
    !["search", "context"].includes(observation.surface) ||
    typeof observation.supported !== "boolean" ||
    observation.abstained !== !observation.supported ||
    observation.querySha256 !== sha256(source.query) ||
    new Set(source.authorizedVaultIds).size !==
      source.authorizedVaultIds.length ||
    observation.scopeSha256 !==
      sha256([...source.authorizedVaultIds].sort().join("\0")) ||
    observation.candidateCount !== observation.candidates.length ||
    source.candidates.length !== observation.candidates.length ||
    observation.admittedCandidateCount !==
      observation.candidates.filter((item) => item.admittedByApplication).length
  ) {
    throw new Error("S2_REBIND_OBSERVATION_OR_SCOPE_MISMATCH");
  }
  const authorized = new Set(source.authorizedVaultIds);
  const pinned = new Map<string, S2AuthorizedSourceCandidate>();
  for (const candidate of source.candidates) {
    const key = sha256(
      `${candidate.documentId}:${candidate.unitId ?? "document"}`,
    );
    if (
      !authorized.has(candidate.vaultId) ||
      pinned.has(key) ||
      !/^[a-f0-9]{64}$/u.test(candidate.sourceUnitSha256) ||
      sha256(candidate.sourceUnitText) !== candidate.sourceUnitSha256
    ) {
      throw new Error("S2_REBIND_UNAUTHORIZED_DUPLICATE_OR_UNPINNED_SOURCE");
    }
    pinned.set(key, candidate);
  }
  const seen = new Set<string>();
  const results = observation.candidates.map(
    (record): S2SourceReboundDecision => {
      const key = record.candidateKeySha256;
      const snapshot = pinned.get(key);
      if (
        !snapshot ||
        seen.has(key) ||
        record.vaultIdSha256 !== sha256(snapshot.vaultId) ||
        record.documentIdSha256 !== sha256(snapshot.documentId) ||
        record.unitIdSha256 !==
          (snapshot.unitId ? sha256(snapshot.unitId) : null) ||
        record.revisionSha256 !== sha256(snapshot.revision) ||
        record.excerptSha256 !== sha256(snapshot.excerpt) ||
        record.trimmedExcerptUtf16Length !== snapshot.excerpt.trim().length
      ) {
        throw new Error("S2_REBIND_IDENTITY_REVISION_OR_EXCERPT_MISMATCH");
      }
      seen.add(key);
      const outcome = (
        status: S2SourceRebindStatus,
        sourceSpan: S2SourceReboundDecision["sourceSpan"] = null,
      ): S2SourceReboundDecision => ({
        candidateKeySha256: key,
        status,
        sourceSpan,
      });
      if (!record.admittedByApplication) return outcome("NOT_ADMITTED");
      if (record.evidenceSpanStatus === "INVALID_EXCERPT")
        return outcome("INVALID_EXCERPT_SPAN");
      const span = record.evidenceSpan;
      if (!span || record.evidenceSpanStatus !== "VALID_EXCERPT")
        return outcome("ADMITTED_NO_READER_SPAN");

      const excerpt = snapshot.excerpt.trim();
      const { startOffsetUtf16: start, endOffsetUtf16: end } = span;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > excerpt.length ||
        !codePointBoundary(excerpt, start) ||
        !codePointBoundary(excerpt, end)
      ) {
        return outcome("INVALID_EXCERPT_SPAN");
      }
      const sourceOffset = snapshot.sourceUnitText.indexOf(excerpt);
      if (sourceOffset < 0) return outcome("SOURCE_EXCERPT_MISSING");
      if (snapshot.sourceUnitText.indexOf(excerpt, sourceOffset + 1) >= 0)
        return outcome("SOURCE_EXCERPT_AMBIGUOUS");
      const absoluteStart = sourceOffset + start;
      const absoluteEnd = sourceOffset + end;
      const actualQuote = snapshot.sourceUnitText.slice(
        absoluteStart,
        absoluteEnd,
      );
      if (
        !codePointBoundary(snapshot.sourceUnitText, absoluteStart) ||
        !codePointBoundary(snapshot.sourceUnitText, absoluteEnd) ||
        sha256(excerpt.slice(start, end)) !== span.quoteSha256 ||
        sha256(actualQuote) !== span.quoteSha256
      ) {
        return outcome("SOURCE_SPAN_HASH_MISMATCH");
      }
      return outcome("SOURCE_SPAN_REBOUND", {
        startOffsetUtf16: absoluteStart,
        endOffsetUtf16: absoluteEnd,
        quoteSha256: span.quoteSha256,
      });
    },
  );
  return {
    schemaVersion: "akp.s2.source-rebind.v1",
    status: "SOURCE_BYTES_CHECKED_SEMANTIC_SUFFICIENCY_NOT_MEASURED",
    querySha256: observation.querySha256,
    scopeSha256: observation.scopeSha256,
    surface: observation.surface,
    admittedCount: observation.admittedCandidateCount,
    admittedWithSourceReboundSpan: results.filter(
      (item) => item.status === "SOURCE_SPAN_REBOUND",
    ).length,
    admittedWithoutSourceReboundSpan: results.filter(
      (item) =>
        item.status !== "SOURCE_SPAN_REBOUND" && item.status !== "NOT_ADMITTED",
    ).length,
    results,
    sourceProvenanceExternallyVerified: false,
    gateAccepted: false,
  };
}
