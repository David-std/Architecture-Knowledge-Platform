/**
 * Opt-in S2 observation of the admission decision made by the search routes.
 * No query, source bytes, answer labels or quote text leave this boundary.
 * Digests are pseudonymous (not anonymous): keep exported traces controlled.
 */
import { createHash } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import {
  retrievalAnswerabilityCandidateKey,
  type RetrievalAnswerabilityAssessment,
} from "@akp/retrieval";

export type S2AdmissionMode =
  "DETERMINISTIC" | "VERIFIER_SHADOW" | "VERIFIER_ENFORCE" | "LAYERED";

export interface S2AdmissionShadowObservation {
  schemaVersion: "akp.s2.admission-shadow.v1";
  status: "ACTUAL_APPLICATION_ADMISSION_DECISION_NOT_GOLD_SCORED";
  surface: "search" | "context";
  admissionMode: S2AdmissionMode;
  querySha256: string;
  scopeSha256: string;
  admissionElapsedMs: number;
  supported: boolean;
  abstained: boolean;
  reason: string;
  candidateCount: number;
  admittedCandidateCount: number;
  candidates: Array<{
    candidateKeySha256: string;
    vaultIdSha256: string;
    documentIdSha256: string;
    unitIdSha256: string | null;
    revisionSha256: string;
    excerptSha256: string;
    trimmedExcerptUtf16Length: number;
    admittedByApplication: boolean;
    passageSupportReason: string | null;
    readerMode: string | null;
    readerIdSha256: string | null;
    readerDecision: string | null;
    readerReasonCode: string | null;
    readerReasonSha256: string | null;
    evidenceSpan: null | {
      startOffsetUtf16: number;
      endOffsetUtf16: number;
      quoteSha256: string;
    };
    evidenceSpanStatus: "NOT_PROVIDED" | "VALID_EXCERPT" | "INVALID_EXCERPT";
  }>;
  /** This record alone cannot establish semantic precision, FAR or final answers. */
  gateAccepted: false;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** A model/provider reason may contain source or query text; never echo it. */
function safeReasonCode(value: string | undefined): string | null {
  if (!value) return null;
  return /^[A-Z][A-Z0-9_:-]{0,119}$/u.test(value)
    ? value
    : "REDACTED_NON_CODE_REASON";
}

function codePointBoundary(text: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  );
}

export function buildS2AdmissionShadowObservation(input: {
  surface: "search" | "context";
  mode: S2AdmissionMode;
  query: string;
  authorizedVaultIds: readonly string[];
  pool: readonly SearchHit[];
  assessment: RetrievalAnswerabilityAssessment;
  admissionElapsedMs: number;
}): S2AdmissionShadowObservation {
  if (
    !Number.isFinite(input.admissionElapsedMs) ||
    input.admissionElapsedMs < 0
  ) {
    throw new Error("S2_ADMISSION_SHADOW_INVALID_DURATION");
  }
  const authorizedVaultIds = new Set(input.authorizedVaultIds);
  const candidateKeys = input.pool.map(retrievalAnswerabilityCandidateKey);
  if (
    candidateKeys.length !== new Set(candidateKeys).size ||
    input.pool.some((hit) => !authorizedVaultIds.has(hit.vaultId)) ||
    input.assessment.supportedCandidateKeys.some(
      (key) => !candidateKeys.includes(key),
    )
  ) {
    throw new Error("S2_ADMISSION_SHADOW_SCOPE_OR_CANDIDATE_MISMATCH");
  }
  const signals = new Map(
    input.assessment.candidateSignals.map((signal) => [
      signal.candidateKey,
      signal,
    ]),
  );
  const admitted = new Set(input.assessment.supportedCandidateKeys);
  const candidates = input.pool.map((hit) => {
    const candidateKey = retrievalAnswerabilityCandidateKey(hit);
    const signal = signals.get(candidateKey);
    const trace = signal?.queryConditionedEvidence;
    // Verifier offsets index the trimmed excerpt, not a generated answer or
    // the original full source unit. Rebase only during source-bound scoring.
    const excerpt = hit.excerpt.trim();
    const span = trace?.evidenceSpan;
    const validSpan = Boolean(
      span &&
      Number.isSafeInteger(span.startOffset) &&
      Number.isSafeInteger(span.endOffset) &&
      span.startOffset >= 0 &&
      span.endOffset > span.startOffset &&
      span.endOffset <= excerpt.length &&
      codePointBoundary(excerpt, span.startOffset) &&
      codePointBoundary(excerpt, span.endOffset),
    );
    return {
      candidateKeySha256: sha256(candidateKey),
      vaultIdSha256: sha256(hit.vaultId),
      documentIdSha256: sha256(hit.documentId),
      unitIdSha256: hit.unitId ? sha256(hit.unitId) : null,
      revisionSha256: sha256(hit.revision),
      excerptSha256: sha256(hit.excerpt),
      trimmedExcerptUtf16Length: excerpt.length,
      admittedByApplication: admitted.has(candidateKey),
      passageSupportReason: signal?.passageSupport.reason ?? null,
      readerMode: trace?.mode ?? null,
      readerIdSha256: trace ? sha256(trace.verifierId) : null,
      readerDecision: trace?.decision ?? null,
      readerReasonCode: safeReasonCode(trace?.reason),
      readerReasonSha256: trace ? sha256(trace.reason) : null,
      evidenceSpan:
        validSpan && span
          ? {
              startOffsetUtf16: span.startOffset,
              endOffsetUtf16: span.endOffset,
              quoteSha256: sha256(
                excerpt.slice(span.startOffset, span.endOffset),
              ),
            }
          : null,
      evidenceSpanStatus: !span
        ? ("NOT_PROVIDED" as const)
        : validSpan
          ? ("VALID_EXCERPT" as const)
          : ("INVALID_EXCERPT" as const),
    };
  });
  return {
    schemaVersion: "akp.s2.admission-shadow.v1",
    status: "ACTUAL_APPLICATION_ADMISSION_DECISION_NOT_GOLD_SCORED",
    surface: input.surface,
    admissionMode: input.mode,
    querySha256: sha256(input.query),
    scopeSha256: sha256([...authorizedVaultIds].sort().join("\0")),
    admissionElapsedMs: input.admissionElapsedMs,
    supported: input.assessment.supported,
    abstained: !input.assessment.supported,
    reason: input.assessment.reason,
    candidateCount: input.pool.length,
    admittedCandidateCount: candidates.filter(
      (item) => item.admittedByApplication,
    ).length,
    candidates,
    gateAccepted: false,
  };
}

/** Evaluation-only hook: a faulty observer must never change the user result. */
export function notifyS2AdmissionShadow(
  sink: ((record: S2AdmissionShadowObservation) => void) | undefined,
  input: Parameters<typeof buildS2AdmissionShadowObservation>[0],
): void {
  if (!sink) return;
  try {
    sink(buildS2AdmissionShadowObservation(input));
  } catch {
    // Best-effort diagnostic side-channel, never an admission authority.
  }
}
